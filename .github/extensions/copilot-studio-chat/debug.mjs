function secretName(key) {
    if (typeof key !== "string") return false;
    const name = key.replace(/[-_\s]/g, "").toLowerCase();
    return /(?:secret|password|credential|authorization|cookie|apikey|privatekey|connectionstring)/.test(name) ||
        /token$|^(?:(?:access|account|subscription|signing|shared|function|master|primary|secondary)key|key)$/.test(name);
}

function redact(value) {
    return JSON.parse(JSON.stringify(value, function (key, entry) {
        if (secretName(key) || (key === "value" && secretName(this.name ?? this.key))) return "***";
        if (typeof entry !== "string") return entry;
        return entry
            .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer ***")
            .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "***")
            .replace(/("?(?:client[_-]?secret|password|secretText|access[_-]?token|refresh[_-]?token|id[_-]?token)"?\s*[:=]\s*"?)[^"',\s]+/gi, "$1***")
            .replace(/([?&](?:token|access_token|refresh_token|id_token|key|api[_-]?key|code|sig|signature|secret|client_secret)=)[^&#\s"']+/gi, "$1***");
    }));
}

export class ConversationData {
    constructor(limit = 1_000_000) {
        this.limit = limit;
        this.revision = 0;
        this.sequence = 0;
        this.clear();
    }

    clear() {
        this.responses = [];
        this.omitted = false;
        this.bytes = 2;
        this.revision++;
    }

    begin(operation) {
        const data = { turnId: ++this.sequence, operation, complete: false, truncated: false, payload: { schemaVersion: "1", activities: [] } };
        const bytes = Buffer.byteLength(JSON.stringify(data));
        this.bytes += bytes + (this.responses.length ? 1 : 0);
        this.responses.push({ data, bytes });
        this.fit(0);
        this.revision++;
        return data.turnId;
    }

    fit(additional) {
        while (this.responses.length > 1 && this.bytes + additional > this.limit) {
            this.bytes -= this.responses.shift().bytes + 1;
            this.omitted = true;
        }
        return this.bytes + additional <= this.limit;
    }

    truncate(response) {
        if (response.data.truncated) return;
        response.data.truncated = true;
        const bytes = Buffer.byteLength(JSON.stringify(response.data));
        this.bytes += bytes - response.bytes;
        response.bytes = bytes;
    }

    activity(activity) {
        const response = this.responses.at(-1);
        if (!response) throw new Error("No conversation response is active.");
        if (response.data.truncated) return;
        const safe = redact(activity);
        const bytes = Buffer.byteLength(JSON.stringify(safe)) + (response.data.payload.activities.length ? 1 : 0);
        if (!this.fit(bytes)) {
            this.truncate(response);
        } else {
            response.data.payload.activities.push(safe);
            response.bytes += bytes;
            this.bytes += bytes;
        }
        this.revision++;
    }

    finish(payload) {
        const response = this.responses.at(-1);
        if (!response) throw new Error("No conversation response is active.");
        const data = { ...response.data, complete: true, truncated: false, payload: redact(payload) };
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (!this.fit(bytes - response.bytes)) {
            this.truncate(response);
        } else {
            this.bytes += bytes - response.bytes;
            response.bytes = bytes;
            response.data = data;
        }
        this.revision++;
    }

    saved() {
        return { omitted: this.omitted, responses: this.responses.map(response => response.data) };
    }

    restore(saved) {
        this.clear();
        if (!saved || typeof saved !== "object" || !Array.isArray(saved.responses)) return false;
        for (const entry of saved.responses) {
            if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.turnId) ||
                !entry.payload || typeof entry.payload !== "object" || !Array.isArray(entry.payload.activities)) continue;
            const data = redact(entry);
            const bytes = Buffer.byteLength(JSON.stringify(data));
            this.bytes += bytes + (this.responses.length ? 1 : 0);
            this.responses.push({ data, bytes });
            this.sequence = Math.max(this.sequence, data.turnId);
        }
        this.omitted = saved.omitted === true || this.responses.length < saved.responses.length;
        while (this.responses.length && this.bytes > this.limit) {
            this.bytes -= this.responses.shift().bytes + (this.responses.length ? 1 : 0);
            this.omitted = true;
        }
        this.revision++;
        return true;
    }

    snapshot(messages = []) {
        return {
            revision: this.revision, messages: redact(messages),
            responses: structuredClone(this.responses.map(response => response.data)),
            truncated: this.omitted || this.responses.some(response => response.data.truncated),
        };
    }
}

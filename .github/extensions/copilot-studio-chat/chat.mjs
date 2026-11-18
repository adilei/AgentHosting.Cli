import { askArguments, identity, parseResult, ReplyStream, resolveTarget, runCommand, validateTarget } from "./client.mjs";
import { ActivityReader } from "./activity-reader.mjs";
import { ConversationData } from "./debug.mjs";
import { FileDownloads, uploads, withUploadedFiles } from "./files.mjs";

const signInMessage = "The msagent CLI is signed out.";

export class ChatRegistry {
    constructor(create, onClose = async () => {}) {
        this.create = create;
        this.onClose = onClose;
        this.panels = new Map();
        this.closing = new Map();
    }

    async open(instanceId, input, context = {}) {
        const closing = this.closing.get(instanceId);
        if (closing) await closing;
        const key = JSON.stringify({ ...input, agentName: undefined });
        let entry = this.panels.get(instanceId);
        if (entry && entry.key !== key) throw new Error("Use a new panel when changing chats.");
        if (!entry) {
            const openContext = { ...context, instanceId };
            entry = { key, context: openContext, ready: Promise.resolve().then(() => this.create(input, openContext)) };
            this.panels.set(instanceId, entry);
        }
        try {
            const resource = await entry.ready;
            if (this.panels.get(instanceId) !== entry) throw new Error("The chat was closed during startup.");
            if (input.agentName) resource.chat.state.agentName = input.agentName;
            return resource;
        } catch (error) {
            if (this.panels.get(instanceId) === entry) this.panels.delete(instanceId);
            throw error;
        }
    }

    async status(instanceId) {
        const entry = this.panels.get(instanceId);
        if (!entry) throw new Error("This chat is closed.");
        const { chat } = await entry.ready;
        const state = chat.snapshot();
        return { status: state.status, busy: state.busy, messageCount: state.messages.length };
    }

    async close(instanceId) {
        const entry = this.panels.get(instanceId);
        if (!entry) return this.closing.get(instanceId);
        this.panels.delete(instanceId);
        const closing = (async () => {
            try {
                await (await entry.ready).server.close();
            } finally {
                await this.onClose(instanceId, entry.context);
            }
        })();
        this.closing.set(instanceId, closing);
        try {
            await closing;
        } finally {
            if (this.closing.get(instanceId) === closing) this.closing.delete(instanceId);
        }
    }

    closeAll() {
        const entries = [...this.panels.values()];
        const closing = [...this.closing.values()];
        this.panels.clear();
        return Promise.allSettled([...closing, ...entries.map(async entry => (await entry.ready).server.close())]);
    }
}

export class Chat {
    constructor(executable, target, runner = runCommand) {
        this.executable = executable;
        this.target = validateTarget(target);
        this.runner = runner;
        this.debug = new ConversationData();
        this.files = new FileDownloads();
        this.state = { status: "unchecked", busy: false, operation: null, account: null, target: this.target, messages: [], error: null };
    }

    snapshot() {
        return structuredClone({ ...this.state, connected: Boolean(this.conversationId),
            debugRevision: this.debug.revision });
    }

    debugSnapshot() {
        return this.debug.snapshot(this.state.messages);
    }

    async command(args, options = {}) {
        return this.runner(this.executable, args, { ...options, signal: this.abort?.signal });
    }

    async checkCapabilities() {
        if (this.capable) return;
        for (const [args, required] of [
            [["test", "ask", "--help"], ["--query", "--file", "--start-conversation", "--conversation-id", "--project", "--agent-id", "--deployment-id",
                "--schema-name", "--environment-id", "--tenant", "--deployment-name", "--json", "--non-interactive"]],
        ]) {
            const result = await this.command(args);
            if (result.code !== 0 || !required.every(option => result.output.includes(option))) {
                throw new Error("This msagent build lacks required canvas capabilities. Install a compatible build; no upgrade was performed.");
            }
        }
        this.capable = true;
    }

    async verifyOpen() {
        await this.start("check");
        if (this.state.status === "authentication-required") {
            throw new Error("The msagent CLI is signed out. Run `msagent auth login`, then open the canvas again.");
        }
        if (this.state.status !== "ready") throw new Error(this.state.error ?? "The chat target could not be checked.");
    }

    async preflight({ allowSignedOut = false } = {}) {
        if (this.requiresReset) {
            this.state.status = "uncertain";
            throw new Error("The previous message may have been delivered. Check remote effects, then start a new conversation.");
        }
        await this.checkCapabilities();
        const resolved = await resolveTarget(this.target, args => this.command(args));
        if (this.resolved && JSON.stringify(this.resolved) !== JSON.stringify(resolved)) {
            this.state.status = "changed";
            throw new Error("The selected target changed. Open a new canvas for that target; this conversation was not reused.");
        }
        this.resolved = resolved;
        this.state.target = resolved;
        const status = parseResult(await this.command(["auth", "status", "--json", "--non-interactive"]));
        this.state.account = status.account ?? null;
        if (!status.signedIn) {
            if (this.identity) {
                this.state.status = "changed";
                throw new Error("The CLI account changed or signed out. Start a new conversation.");
            }
            this.state.status = "authentication-required";
            if (allowSignedOut) return status;
            throw new Error(signInMessage);
        }
        const current = identity(status);
        if (this.identity && this.identity !== current) {
            this.state.status = "changed";
            throw new Error("The CLI account changed. Start a new conversation before sending.");
        }
        this.identity ??= current;
        this.state.status = "ready";
        return status;
    }

    start(operation, input = {}) {
        if (this.state.busy) throw new Error("Wait for the current operation or cancel it first.");
        if (!["check", "connect", "send", "reset"].includes(operation)) throw new Error("Unknown operation.");
        if (operation === "connect" && this.conversationId) throw new Error("Already connected. Start a new chat to reconnect.");
        if (operation === "send" && (typeof input.query !== "string" || !input.query.trim() ||
            input.query.length > 16_000 || input.query.includes("\0"))) {
            throw new Error("Enter a message of at most 16,000 characters.");
        }
        if (operation === "send" && this.state.messages.length >= 100) throw new Error("Start a new conversation; this chat reached its limit.");
        const attachments = operation === "send" ? uploads(input.files) : [];
        this.state.busy = true;
        this.state.operation = operation;
        this.state.error = null;
        if (operation === "reset") this.debug.clear();
        this.abort = new AbortController();
        this.pending = this.perform(operation, input, attachments).catch(error => {
            this.state.error = error.message;
            if (this.turnAttempted && (this.startAttempted || error.data?.queryDelivery !== "not-attempted")) {
                this.requiresReset = true;
                this.state.status = "uncertain";
                this.state.error += " Remote effects may have occurred. Check them before starting a new conversation.";
            } else if (error.authRequired) {
                this.state.status = "authentication-required";
            } else if (!["changed", "authentication-required", "uncertain"].includes(this.state.status)) {
                this.state.status = "error";
            }
        }).finally(() => {
            for (const message of this.state.messages) {
                if (message.streaming) {
                    message.streaming = false;
                    message.partial = true;
                }
            }
            this.state.busy = false;
            this.state.operation = null;
            this.abort = null;
            this.turnAttempted = false;
            this.startAttempted = false;
            this.debug.revision++;
        });
        return this.pending;
    }

    async perform(operation, input, attachments) {
        if (operation === "reset") {
            this.requiresReset = false;
            this.identity = null;
            this.conversationId = null;
            this.state.messages = [];
            this.files.clear();
            if (input.reconnect === true) {
                operation = "connect";
                this.state.operation = operation;
            }
        }
        const live = operation === "send" || operation === "connect";
        await this.preflight({ allowSignedOut: !live });
        if (!live) return;
        const turnId = this.debug.begin(operation);
        if (operation === "send") this.state.messages.push({ role: "user", text: input.query, turnId,
            ...(attachments.length ? { files: attachments.map(file => ({ name: file.name, size: file.size })) } : {}) });
        const preview = new ReplyStream([]);
        let replyIndex;
        const showReply = (reply, streaming, partial) => {
            const snapshot = reply.snapshot();
            if (streaming && !snapshot.text && !snapshot.attachments.length) return;
            if (operation === "connect" && !snapshot.text && !snapshot.attachments.length) return;
            const files = snapshot.attachments.map(file => this.files.add(turnId, file)).filter(Boolean);
            const message = {
                role: "assistant", turnId, partial: partial || snapshot.partial, streaming,
                text: snapshot.text || (files.length ? "" : "[No supported user-facing text was returned.]"),
                ...(files.length ? { files } : {}),
            };
            const messages = this.state.messages.slice();
            if (replyIndex === undefined) replyIndex = messages.length;
            messages[replyIndex] = message;
            if (JSON.stringify(messages).length > 1_000_000) {
                this.state.messages = this.state.messages.slice(-2);
                if (JSON.stringify(this.state.messages).length > 1_000_000) {
                    this.state.messages = this.state.messages.filter(entry => entry.role === "user").slice(-1);
                }
                throw new Error("Transcript limit reached; older messages were discarded. Start a new conversation.");
            }
            this.state.messages = messages;
        };
        const reader = new ActivityReader(activity => {
            this.debug.activity(activity);
            preview.write(activity);
            showReply(preview, true, true);
        });
        try {
            const data = await withUploadedFiles(attachments, async paths => {
                const args = askArguments(this.resolved, operation === "connect" ? undefined : input.query, this.conversationId);
                for (const file of paths) args.push("--file", file);
                this.turnAttempted = true;
                this.startAttempted = operation === "connect";
                return parseResult(await this.command(args, { onStdout: text => reader.push(text) }));
            });
            this.debug.finish(data);
            if (data.schemaVersion !== "1" || data.status !== "completed" || data.exitCode !== 0 ||
                typeof data.conversationId !== "string" || !data.conversationId ||
                /[\x00-\x20/\\?#%]/.test(data.conversationId) || data.conversationId.length > 1024 ||
                (this.conversationId && this.conversationId !== data.conversationId)) {
                throw new Error("Invalid conversation outcome. Start a new conversation after checking remote effects.");
            }
            await this.preflight();
            showReply(new ReplyStream(data.activities), false, false);
            this.conversationId = data.conversationId;
        } catch (error) {
            if (error.data) this.debug.finish(error.data);
            if (error.data?.activities) showReply(new ReplyStream(error.data.activities), false, true);
            throw error;
        }
    }

    cancel() {
        this.abort?.abort();
    }

    async close() {
        this.cancel();
        await this.pending;
    }
}

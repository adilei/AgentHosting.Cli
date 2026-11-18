import { mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const sessionPattern = /^[A-Za-z0-9_-]{1,128}$/;
const instancePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function defaultStartedDirectory() {
    return path.join(process.env.COPILOT_HOME || path.join(homedir(), ".copilot"),
        "extensions", "copilot-studio-chat", "artifacts", "started");
}

export class StartedChats {
    constructor(directory = defaultStartedDirectory()) {
        this.directory = directory;
    }

    marker(sessionId, instanceId) {
        if (typeof sessionId !== "string" || !sessionPattern.test(sessionId) ||
            typeof instanceId !== "string" || !instancePattern.test(instanceId)) {
            throw new Error("Invalid canvas session or instance identifier.");
        }
        return path.join(this.directory, sessionId, instanceId);
    }

    async claim(sessionId, instanceId) {
        const file = this.marker(sessionId, instanceId);
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        try {
            await writeFile(file, "", { flag: "wx", mode: 0o600 });
            return true;
        } catch (error) {
            if (error.code === "EEXIST") return false;
            throw error;
        }
    }

    async release(sessionId, instanceId) {
        try {
            await unlink(this.marker(sessionId, instanceId));
            return true;
        } catch (error) {
            if (error.code === "ENOENT") return false;
            throw error;
        }
    }
}

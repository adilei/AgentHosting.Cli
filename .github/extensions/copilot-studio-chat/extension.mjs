import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { Chat, ChatRegistry } from "./chat.mjs";
import { resolveExecutable, validateTarget } from "./client.mjs";
import { startServer } from "./server.mjs";
import { StartedChats } from "./started.mjs";

const started = new StartedChats();
const registry = new ChatRegistry(async (input, context) => {
    const executable = await resolveExecutable(input.executablePath);
    const chat = new Chat(executable, input.target);
    await chat.verifyOpen();
    const server = await startServer(chat);
    try {
        if (await started.claim(context.sessionId, context.instanceId)) chat.start("connect");
        else chat.state.restored = true;
        return { chat, server };
    } catch (error) {
        await server.close();
        throw error;
    }
}, (instanceId, context) => started.release(context.sessionId, instanceId));
const text = { type: "string", minLength: 1, maxLength: 4096 };
const selector = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,256}$" };
const inputSchema = {
    type: "object", additionalProperties: false, required: ["chatId", "target"],
    properties: {
        chatId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
        agentName: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S" },
        executablePath: text,
        target: {
            oneOf: [
                {
                    type: "object", additionalProperties: false, required: ["project", "agentId", "deploymentId"],
                    properties: { project: text, agentId: selector, deploymentId: selector },
                },
                {
                    type: "object", additionalProperties: false,
                    required: ["schemaName", "environmentId", "tenantId", "deploymentName"],
                    properties: { schemaName: selector, environmentId: selector, tenantId: text, deploymentName: selector },
                },
            ],
        },
    },
};

await joinSession({
    canvases: [createCanvas({
        id: "copilot-studio-chat",
        displayName: "Copilot Studio chat",
        description: "Chat with a Copilot Studio agent. Before opening, sign in with msagent auth login and choose the agent. Opening a new canvas starts a live conversation.",
        inputSchema,
        actions: [{
            name: "get_status",
            description: "Get connection state and message count without transcript or authentication data.",
            inputSchema: { type: "object", additionalProperties: false },
            handler: async ctx => {
                try { return await registry.status(ctx.instanceId); }
                catch (error) { throw new CanvasError("chat_closed", error.message); }
            },
        }],
        open: async ctx => {
            const input = ctx.input;
            try {
                validateTarget(input.target);
                const entry = await registry.open(ctx.instanceId, input, { sessionId: ctx.sessionId });
                return { title: "Copilot Studio chat", url: entry.server.url };
            } catch (error) {
                throw new CanvasError("chat_open_failed", error.message);
            }
        },
        onClose: ctx => registry.close(ctx.instanceId),
    })],
});

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        registry.closeAll()
            .then(results => {
                const failed = results.some(result => result.status === "rejected");
                process.exit(failed ? 1 : 0);
            });
    });
}

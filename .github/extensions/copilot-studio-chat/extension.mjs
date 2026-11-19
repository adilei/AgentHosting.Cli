import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { Chat, ChatRegistry } from "./chat.mjs";
import { resolveExecutable, validateConfiguredInput, validateTarget } from "./client.mjs";
import { startServer } from "./server.mjs";
import { attachChat, pruneStarted, StartedChats } from "./started.mjs";
import { SetupChat } from "./setup.mjs";

const started = new StartedChats();
const registry = new ChatRegistry(async (input, context) => {
    let configuredFromSetup = false;
    if (!input.target) {
        const saved = await started.load(context.sessionId, context.instanceId);
        if (saved?.openInput) {
            input = validateConfiguredInput(saved.openInput);
            configuredFromSetup = true;
        }
    }
    if (!input.target) {
        const chat = new SetupChat(() => session.send({
            prompt: `The user clicked 'Choose an agent with Copilot' in the unconfigured Copilot Studio chat canvas with instanceId ${JSON.stringify(context.instanceId)}. ` +
                "Help them select a Copilot Studio agent and environment in this main chat, using `msagent auth create` here if sign-in is needed. " +
                "Do not choose an arbitrary target or start a live conversation before the agent is selected. " +
                "Once selected, invoke this canvas instance's configure action with the complete target and the agent's known friendly name in agentName. Do not open a new canvas.",
            source: "system",
            mode: "enqueue",
        }), async (selected, isClosed) => {
            validateConfiguredInput(selected);
            const executable = await resolveExecutable(selected.executablePath);
            const configured = new Chat(executable, selected.target);
            await configured.verifyOpen();
            if (isClosed()) throw new Error("This canvas was closed during setup.");
            if (selected.agentName) configured.state.agentName = selected.agentName;
            try {
                await attachChat(configured, started, context.sessionId, context.instanceId, selected, isClosed);
                return configured;
            } catch (error) {
                await configured.close();
                throw error;
            }
        });
        return { chat, server: await startServer(chat) };
    }
    const executable = await resolveExecutable(input.executablePath);
    const chat = new Chat(executable, input.target);
    await chat.verifyOpen();
    const server = await startServer(chat);
    try {
        if (input.agentName) chat.state.agentName = input.agentName;
        await attachChat(chat, started, context.sessionId, context.instanceId, configuredFromSetup ? input : undefined);
        return { chat, server };
    } catch (error) {
        await server.close();
        throw error;
    }
}, (instanceId, context) => started.release(context.sessionId, instanceId));
const text = { type: "string", minLength: 1, maxLength: 4096 };
const selector = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,256}$" };
const configuredInputSchema = {
    type: "object", additionalProperties: false, required: ["chatId", "target"],
    properties: {
        chatId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
        agentName: { type: "string", minLength: 1, maxLength: 256, pattern: "\\S",
            description: "Selected agent's friendly display name, when known, for chat message labels." },
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
const inputSchema = {
    anyOf: [
        { type: "null" },
        { type: "object", maxProperties: 0 },
        configuredInputSchema,
    ],
};

const session = await joinSession({
    canvases: [createCanvas({
        id: "copilot-studio-chat",
        displayName: "Copilot Studio chat",
        description: "Chat with a Copilot Studio agent. Empty opens show setup through Copilot; a selected target starts a live chat. Provide the agent's friendly name when known.",
        inputSchema,
        actions: [{
            name: "get_status",
            description: "Get connection state and message count without transcript or authentication data.",
            inputSchema: { type: "object", additionalProperties: false },
            handler: async ctx => {
                try { return await registry.status(ctx.instanceId); }
                catch (error) { throw new CanvasError("chat_closed", error.message); }
            },
        }, {
            name: "configure",
            description: "Configure this existing setup canvas after the user selects an agent; starts a live conversation.",
            inputSchema: configuredInputSchema,
            handler: async ctx => {
                try {
                    validateConfiguredInput(ctx.input);
                    return await registry.configure(ctx.instanceId, ctx.input);
                } catch (error) {
                    throw new CanvasError("chat_setup_failed", error.message);
                }
            },
        }],
        open: async ctx => {
            const input = ctx.input ?? {};
            try {
                if (input.target) validateTarget(input.target);
                const entry = await registry.open(ctx.instanceId, input, { sessionId: ctx.sessionId });
                return { title: "Copilot Studio chat", url: entry.server.url };
            } catch (error) {
                throw new CanvasError("chat_open_failed", error.message);
            }
        },
        onClose: ctx => registry.close(ctx.instanceId),
    })],
});

pruneStarted(started, session.sessionId, instanceId => registry.panels.has(instanceId) || registry.closing.has(instanceId))
    .catch(error => session.log(`Copilot Studio chat could not clean up saved conversations: ${error.message}`, { level: "warning", ephemeral: true }));

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
        registry.closeAll()
            .then(results => {
                const failed = results.some(result => result.status === "rejected");
                process.exit(failed ? 1 : 0);
            });
    });
}

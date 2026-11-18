# Copilot Studio chat canvas

A project-scoped GitHub Copilot app canvas backed by `msagent test ask --json`.
It does not embed Playground or start a separate chat browser/terminal.

## Requirements

- GitHub Copilot app/runtime with extension canvases enabled. This SDK surface is
  experimental; unsupported hosts cannot render the pane.
- Node.js 22 or newer and an installed msagent executable with
  `test ask --start-conversation` and `--file`. This change adds both options;
  there is no claimed released minimum CLI version.
- The .NET and ASP.NET Core runtimes required by that CLI build.
- A selected public-cloud, production-ring account with access to the agent.
  The canvas never signs in; it reuses the CLI account from `msagent auth login`.

The extension does not install dependencies, upgrade msagent, enable feature
flags, create app registrations, deploy agents, or publish anything.

## Open

The runtime discovers this directory in a trusted repository. Reload extensions
after changes, then ask Copilot to open the **Copilot Studio chat** canvas with
one explicit target. The canvas type ID is `copilot-studio-chat`.

Registered target input:

```json
{
  "chatId": "my-agent-dev",
  "target": {
    "project": "/absolute/path/to/registered/project",
    "agentId": "local-managed-agent-id",
    "deploymentId": "local-deployment-id"
  }
}
```

For Windows use an absolute Windows project path. Alternatively, supply a
complete explicit target with no registration:

```json
{
  "chatId": "explicit-agent-dev",
  "target": {
    "schemaName": "agent_schema",
    "environmentId": "environment-id",
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "deploymentName": "development"
  }
}
```

An explicit deployment name is only a descriptive label, not a verified
registry association. Local managed-agent IDs are not cloud MCS IDs; the canvas
does not accept a cloud MCS ID as an alternative selector.

Supply `agentName` with the selected agent's display name for assistant bubble
headings. Without it, headings use the target's schema name or local agent ID.
This label does not change the selected target.

Optionally add `executablePath` with the absolute path to the compatible
msagent executable. Otherwise the extension resolves `msagent` (`msagent.exe`
on Windows) from absolute PATH entries. It does not execute `.cmd` shims through
a shell; point at the actual CLI executable when needed. For a local contributor
build, use the apphost under `src/Microsoft.Agents.Hosting.Cli/bin/Debug/net10.0/`.

Each canvas has its own conversation and transcript, even if another canvas uses
the same `chatId`. Reopening an existing panel reuses its conversation. Closing a
panel ends its backend and discards its transcript.

## Use

Copilot opens the canvas for an agent it selected. Opening checks command
capabilities, local registry association and auth status; it fails if the CLI
is signed out, so Copilot can run `msagent auth login` and reopen it. Opening
never signs in. The compact header shows the selected agent and status. Open
**Connection details** (the three-dot control) for account, environment/tenant
IDs and status refresh. The canvas reuses the CLI's account; it does not handle
Entra tokens or run `auth login`. If the CLI signs out or needs consent later,
the pane shows **Signed out**; sign in again with `msagent auth login`, then
select **New chat** or retry **Send**. CLI authentication is unchanged.

Once the checks pass, opening a new canvas automatically starts a live
conversation. This runs `test ask --start-conversation --json --non-interactive`
once, displays any opening activities and retains the returned conversation ID.
It does not send a synthetic user message. Starting a conversation may itself
run configured topics/actions, use credits, and an agent is not required to
provide a greeting. Reopening an open canvas reuses its conversation. Open canvas
IDs are recorded under
`$COPILOT_HOME/extensions/copilot-studio-chat/artifacts/started/`. When the
extension or app restarts, the runtime reopens existing canvases, but they show
**Conversation ended** and make no live call until you select **New chat**.
Closing a canvas removes its ID, so opening it again starts a new conversation.
**New chat** discards the current conversation (or a failed or uncertain one) in
that canvas only and immediately starts a fresh one. New chat and Send are live
actions that may use credits or change data.

Each message
starts a background `test ask --json --non-interactive` process. Continuations
use only the returned conversation ID with the same target. The extension
rechecks registry metadata and selected account around turns; do not switch CLI
accounts concurrently with a running turn. An observed identity/target change
stops continuation.

Press **Enter** to send, or **Shift+Enter** for a new line. Sending clears the
composer immediately. A failed send restores the draft only if it has not been
edited since submission. A typing indicator appears immediately when connecting
or sending and clears on completion, cancellation or failure, not during local
status checks.

Replies update while the CLI is running: complete activities are parsed
incrementally from its single JSON document, and the pane refreshes every
100 ms during a turn. Copilot Studio `chunkType: delta` fragments are appended,
including whitespace and the initial fragment before its stream ID arrives;
`replace` snapshots and final messages replace earlier text for that stream.
Stale updates and duplicate finals are ignored. Update
granularity depends on what Copilot Studio and the SDK emit, not individual
tokens. Informative/diagnostic events and unknown delta payloads are not rendered.
The final JSON result and conversation metadata are validated before the reply
is marked complete. Interrupted replies retain their text marked incomplete,
and streams without a final snapshot remain marked incomplete. Cards
and attachments receive an unsupported-content notice; interactive submissions,
connector sign-in and durable transcript storage are not supported.

Assistant replies render a safe Markdown subset while updating: headings,
paragraphs, emphasis, inline/fenced code, simple lists, blockquotes, rules and
pipe tables. Raw HTML is displayed literally; images are replaced by their alt
text without loading them. Only explicit HTTP(S) links are clickable, opening
on user interaction with no referrer. Other URL schemes remain literal text.
This is not a full CommonMark/GFM implementation; nested lists and advanced
extensions are not supported. Replies over 100,000 characters or 2,000 rendered
elements fall back visibly to full plain text. No external renderer is loaded.

**Cancel** stops the local invocation, not remote actions already delivered.
Unknown outcomes require checking remote effects and selecting **New chat**.
No message is retried automatically, including after sign-in. If a connected
chat reports that a message was not attempted because sign-in or consent is
needed, sign in again, then send the restored draft again. If a
connection start has an uncertain outcome, check remote effects and select
**New chat**.
An observed account change also requires a new conversation. A changed
registered target requires reopening with a new chat ID.

The pane retains drafts on failure. Transcripts are in memory only and disappear
when the backend/extension/app restarts or the last panel closes. Refreshing the
iframe while its backend lives preserves the chat. The limits are 16,000 input
characters, 100 transcript entries, 1 MB retained transcript, 4 MiB combined CLI
output per operation and a two-minute operation timeout.

### Conversation data (JSON)

Use the **Chat / Debug** switch to choose between the rendered conversation and
raw response data; they are separate views with the same composer and session.
Chat is selected by default. Debug is an alternate representation of the same
conversation, not a separate recorder: messages and responses already received
in Chat are immediately available in Debug. Switching views is presentation-only
and works during streaming; it never sends a message or restarts the conversation.

Use **Find in debug data** to search the displayed JSON, ignoring case. The current
match is highlighted; use **Previous** and **Next**, or Shift+Enter and Enter, to
move through matches. Results update as the conversation data changes.

Each bubble has an ellipsis menu with **View debug**. It switches views and
highlights that turn's raw response for an agent bubble, or the input JSON for a
user bubble. Stable turn IDs keep the link correct through streaming and repeated
text. If older raw response details were discarded, the corresponding transcript
entry is highlighted instead and the omitted-data notice remains visible.

The debug view includes the current transcript and responses from conversation starts and
subsequent sends. Each response shows activities as they arrive, including
informative/tool events omitted from chat, followed by the final CLI JSON envelope.
It shows only what `ask` emits; hidden reasoning or tool
details not returned by the service are not available.

Raw response history is capped at 1 MB and kept only in memory alongside the
conversation. Older raw responses are discarded first when needed; oversized
responses retain a bounded prefix. Incomplete and omitted response details are
explicitly labeled without removing messages from the chat transcript.
New chat clears both representations.
Known credential fields, bearer/JWT strings and credential URL parameters are
masked as `***`. Arbitrary agent/business data can still be sensitive: this is
not a general-purpose data-loss-prevention filter. Auth results and CLI stderr
are never retained in conversation data. Payloads are displayed as inert JSON text, never Markdown
or executable content, and are not written to logs or exposed by canvas actions.

### Files

Use **Attach files** to select up to five files, at most 10 MiB total. Selection
stays local until you select **Send** with a nonblank message. Files can be removed
before sending. The extension stages private temporary files, passes only their
paths to `test ask --file`, and deletes them after the invocation, including
failures and cancellation. The transcript retains names and sizes, not upload bytes.
The installed CLI must support `--file`; the agent controls which file types it accepts.

File attachments returned by the agent have **Download** buttons. Downloads use
the protected local gateway and are never fetched automatically. Inline base64
files and public HTTPS URLs are supported, with a 10 MiB download limit, bounded
redirects, and no CLI credentials forwarded. Private/loopback destinations and
links requiring an additional login are not supported. Expired or unsupported
files report an error rather than retrying the agent.

Download references are held only in memory with a 10 MiB URL/data budget; older
references can expire when the limit is reached. New chat clears them. Files are
saved as attachments, never embedded or executed.

## Privacy and local access

Microsoft tokens stay in the CLI and its normal secure cache. The renderer and
extension never request token output. Auth errors are reduced to safe messages;
stderr and raw auth results are not exposed through canvas actions. The only
agent-callable action reports status, busy state and message count.

Messages are passed as literal CLI arguments, not shell commands. Arguments may
be visible to local process inspection; do not paste credentials. Treat agent
replies as untrusted text. Links are not auto-opened and HTML is not executed.
Chat invokes real services and can consume credits or change data.

The loopback server requires a random capability for data/actions, checks
Host/Origin, does not enable CORS, and serves a restrictive CSP. The capability
in the canvas URL fragment is local authorization, not a Microsoft token.
Closing the pane stops owned children and closes the listener.

## Development

No npm dependencies or build step are needed:

```text
node --test .github/extensions/copilot-studio-chat/chat.test.mjs
```

Tests use fake CLI results and local Node subprocesses, not cached credentials
or live agents. Reloading extensions ends the in-memory conversations in open
canvases. Discovery, capability and status checks are read-only; opening a new
canvas starts a live conversation. Live acceptance requires explicit
target/effects approval and a record following `docs/developer/ManualTesting.md`;
no cross-platform live compatibility is claimed by the offline suite.

This is a repository extension, not a marketplace plugin installation.

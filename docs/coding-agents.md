# Coding agents on macOS

OpenBot can run local Codex and Claude Agent SDK profiles at the same time.
Each profile has a working folder, permissions, instructions, and default model choices.
Each conversation can override the model and reasoning effort.

The native launcher enables local profiles for administrators.
The server disables local profiles unless `OPENBOT_LOCAL_AGENTS=1` is present.
Local profiles remain private to their owner.
CopilotKit Intelligence still provides chat transport and history.
Coding profiles do not require an OpenAI or Anthropic API key.

## Run this fork

The native launcher and its installed runtime are separate directories.
Changes in this checkout do not update an existing runtime in `~/OpenBot`.
Both the server and web app must run from this branch to show these features.

1. Configure a local source deployment with the [development instructions](development.md).
2. Apply the migrations with `bun --env-file=.env server/scripts/migrate.ts`.
3. Start the source deployment with `OPENBOT_LOCAL_AGENTS=1 bash scripts/start.sh`.

The native launcher sets the flag automatically when it starts this version of the server.
Existing LangGraph containers also need a rebuild to expose their new model controls.

## Create profiles

1. Install Codex on the Mac that runs the OpenBot server.
2. Authenticate Codex with `codex login` and select the ChatGPT account.
3. For Claude, authenticate Claude Code with `claude auth login`.
4. Open **Agents → Add coding agent**.
5. Select the framework and enter the absolute working folder path.
6. Select **Read only** or **Allow edits in this folder**.
7. Create the profile.
8. Open the profile's **Connection** panel to select its default model and effort.
9. Create another profile for the other framework.

Each framework uses its own CLI account.
OpenBot does not pass its deployment API keys to these processes.
These local profiles require subscription authentication and do not fall back to API billing.

Codex uses its workspace sandbox for edits and commands.
Claude supports file reads and edits within the selected permissions.
Claude shell tools are unavailable until OpenBot has an interactive approval interface.

## Change a conversation

1. Open a conversation with the profile.
2. Select **Model** or **Effort** above the conversation.
3. Wait for the choice to save before you send the next message.

The change applies to the next turn.
Other conversations and profile defaults remain independent.
The server saves choices separately for each user, profile, and conversation.
Model lists and effort choices come from the framework.

The **Connection** panel includes runtime status and **Stop runtime**.
A stopped runtime starts again when a conversation or metadata request needs it.
The native session remains available while its runtime runs.
After a runtime restart, OpenBot starts a new native session with the saved text conversation.

## Read account usage

Open **Account usage** above the conversation.

Codex reports ChatGPT usage windows and reset times through its app-server interface.
Claude reports subscription windows when its SDK exposes them for the account.
The Claude usage interface is experimental and tied to the pinned SDK version.

The panel shows the last update time.
A failed or unsupported read does not appear as zero usage.
Account limits are separate from a conversation's token count or estimated cost.
The LangGraph adapter does not expose account limits.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

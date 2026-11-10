# Project computers

Status: experimental prototype on `dusty/experimental`. This branch is a checkpoint, not a release candidate.
The source includes Bot execution and desktop credential grants.
Authenticated Codex turns, a model change, ordinary Bot commands, and a local Git commit passed live testing.

Known gaps: authenticated Claude Bot turns are not connected, provider quotas are unavailable, and local ad hoc builds can repeat Keychain prompts.
The latest reconnect responsiveness fix is tested in source but is not in the installed Mac app.
The separate coding-turn credential read can still wait on a Keychain dialog.
See the sections below for validation details and limits. No PR accompanies this checkpoint.

## Current implementation

The desktop calls the Rust library in `desktop/workspaces` directly through Tauri commands.
It does not start a coding HTTP service.
Lima 2.3 or newer runs VMs with Apple's Virtualization framework.
Debian 13 is the default OS. VM creation also offers Ubuntu 24.04 LTS.
Each option uses a pinned official cloud image and its matching package defaults.
The saved recipe records the selected OS. Existing VMs keep their current OS.
The image URL and checksum are pinned in the controller.

Each VM has a private record, a project disk, and a saved recipe.
The recipe selects its repository, source branch, CPU count, memory, disk capacity, packages, tools, setup commands, verification commands, and preview ports.
The default recipe installs OpenBot, Node, Bun, Codex, Claude Code, and Docker inside the guest.

Setup records package installation, source checkout, project setup, and verification as separate stages.
Retries skip completed stages and keep the project disk after a failure.
OpenBot marks a VM ready after all required verification commands pass.
Stop preserves the disk and releases the VM's compute resources.

Delete is a separate action with a confirmation that requires the VM's name.
The native controller rejects deletion while a manual terminal is open.
Before deletion, the worker cancels active jobs, removes credential grants, and requests server unregistration.
It requires the server's acknowledgement before it removes a paired VM.
A shared usage guard prevents deletion while a command, terminal, or coding turn still uses the VM.
The controller deletes only the selected VM and its saved record.
If the VM cannot stop or deletion fails, the controller keeps its record for another attempt.

The main app's Computers section combines existing browser and host-folder controls with VMs.
Each VM offers recipe creation, setup output, start, stop, live ports, and an interactive guest shell.
Open it from the sidebar, the app's Computers menu item, or Command-Shift-E.
The old Workspaces URL and personal Computer settings entry redirect to this page.
Computers → This Mac contains the former Settings → This computer controls.
The legacy `/settings/this-computer` URL redirects to `/computers/home`.
The interface uses the app's shared page, row, field, and control components.

A Computer is the execution environment. A project is a repository and folder on that Computer.
The first prototype gives each project its own VM.
Native records, commands, and the Rust crate retain their original workspace names for compatibility.
The existing server ComputerProvider handles browser computers and their lifecycle.
The Computer gateway also supports desktop VM targets for its existing file and command tools.
Policy, approval, and audit controls apply before the gateway sends those operations to the desktop.
A VM assignment cannot silently fall back to a browser computer.
Browser control on these VMs remains unsupported.
The shell uses a PTY over Lima's authenticated SSH connection.
It supports manual package installation without exposing a host command interface.

## Isolation and access

The controller mounts no host folders and forwards no host account files or SSH agent.
It clears inherited host environment variables before it starts Lima commands.
The guest cannot reach host localhost through Lima's default network.
Each explicit preview port binds to host loopback.
Dynamic port forwarding and Lima's guest agent are disabled.

Internet access remains available for package installation and project work.
This prototype does not enforce outbound network policy or block access to the local network.
Network governance is outside the first milestone.

The app page receives native commands through the desktop's existing exact-origin permission mechanism.
The controller accepts a workspace ID, rather than a host path, for each operation.
Saved recipes and logs have private filesystem permissions.

## Environment layers

The first version starts from the selected pinned cloud image and installs the saved recipe.
A future OpenBot base image can contain common tools to reduce creation time.
That image must have a version and a verified digest.
Project-specific packages, tool versions, skills, and setup commands remain in the recipe.

Bots and people can install additional packages inside a VM.
Those changes remain on its project disk.
A future action can save selected environment changes to the recipe for repeatable VM creation.
Workspaces can install frozen skill instructions during creation.
Automatic recipe discovery, custom base images, VM snapshots, and rebuild remain future work.

## Credentials

VM creation does not copy desktop credentials into the guest.
Codex and Claude Code are installed without account authentication.

The native ChatGPT flow uses OpenBot's own OAuth registration, PKCE, state, nonce, and signed identity validation.
The desktop stores renewable credentials in the OS credential store.
The VM receives only an access token for its Codex process through authenticated SSH input.
The controller does not write that token to guest authentication files, recipes, or command arguments.
Codex excludes the token from command and MCP child environments.

Each VM needs an explicit ChatGPT grant after pairing with its owner.
Another VM can reuse the account only after an explicit grant for that VM and the same owner.
Account disconnection cancels coding operations and clears those grants.
The first prototype keeps VM grants in native memory and clears them after connection loss or a server restart.

The current source also binds the ChatGPT grant to the OpenBot account and installation.
Metadata without a `grantId` requires a fresh sign-in before account binding.
The desktop restores workspace pairing after a server restart.
It preserves workspace ownership, but each restart still clears temporary model grants.
Passive status requests read public account metadata and do not open the credential store.

The general password-manager layer remains future work.
It requires service-specific access and a stated purpose, rather than a socket that returns desktop secrets.
Passkey private keys remain in their authenticator.
Any host authentication flow must preserve its relying-party origin and user confirmation.
Password-manager and passkey integration are not implemented yet.

Codex documents a custom Responses provider using a Sign in with ChatGPT access token in a process environment variable.
That path avoids a guest auth file and does not use the internal-only `chatgptAuthTokens` API.
OpenBot needs its own OAuth grant with `chatgpt.tokens.use.direct` and `resource.invoke` scopes.
An existing host Codex login or the desktop's older provider grant must not be assumed compatible.
The desktop retains refresh tokens and gives the selected process only a current access token.
Guest root can still inspect that process. Memory-only credentials are not inaccessible to the VM.
The token must not pass into command or MCP child environments.
Synthetic OAuth tests cover the flow, token renewal, and protected storage without a real account.
A real OpenBot-owned ChatGPT sign-in and authenticated guest turn passed live testing after a host identity fix.
The host identity fix uses a stable UUIDv4 URN.
See the [official app-server integration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and [sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

## Computer and Bot configuration

A Computer owns project files, installed tools, resource allocation, and preview exposure.
A Bot owns instructions, runtime choice, and model defaults.
Several Bots can use one Computer.
Each coding conversation has its own runtime session on that Computer.

The intended conversation Details panel shows its Computer, runtime, effective model, effort, speed, and preview access.
Bot configuration supplies defaults. Conversation changes apply at the next turn.
The API can save workspace bot settings in the Bot's configuration.
Native Codex model discovery now reads the catalogue from the installed guest CLI over SSH stdio.
It reads supported efforts and service tiers without copying desktop authentication.
Frames, queues, total output, and discovery time are bounded.
The creation screen saves Codex defaults and project permissions in the Bot configuration.
An eligible Bot's setup screen can also edit its saved model, effort, speed, and permission defaults.
The server supplies the authoritative `canEditCodingDefaults` verdict; the browser does not infer ownership or edit rights.
Changes to these defaults do not replace the Bot or its conversations.

`workspace-write` remains the default Codex permission.
The optional `vm-full-access` permission maps to Codex's `danger-full-access` sandbox mode inside the guest.
It lets the coding harness perform work beyond the project folder, including Git operations and package installation.
This grants access to the VM, not to host folders. The controller still mounts no host folders.
These harness permissions do not make internal harness commands pass through the ordinary Computer gateway's approvals.
Coding conversations include a model, effort, and speed picker that saves changes for the next turn.
The native worker drives Codex over SSH stdio and returns events through the existing conversation runtime.
Claude Code installation is available, but native Claude turns remain unsupported.
The retired HTTP coding bridge is not an execution target for this design.

The API mounts the desktop Computer broker at `/api/desktop-computers`.
They bind an owner through a single-use pairing ticket and authenticate desktop requests with the existing desktop bearer token.
Operations carry owner, Bot, computer, conversation, and run identities.
The broker bounds output and supports sequenced events, delivery leases, cancellation, and run deadlines.
The broker keeps active registrations and replay tracking in server memory.
After a server restart, the native worker stops old jobs and restores saved workspace pairings.
The native worker polls this API, even after the Computer page closes.
It opens no coding HTTP listener.
The worker accepts only known VM records and checks the paired owner before each operation.
It bounds concurrent jobs, queues, frames, and output.
Duplicate delivery does not execute the same operation twice within the current server session.
Private host records bind Codex session IDs to the owner, Bot, Computer, and conversation.
Those records preserve conversation resumption across app restarts, after the person grants model access again.
Concurrent coding turns on the same binding refuse instead of sharing one live session.

### Automatic reconnection

The new database tables record the workspace owner, desktop installation, binding ID, and reconnect secret hash.
The desktop stores the reconnect secret in the OS credential store.
Its local index contains identifiers, without the secret.
The server also keeps a persistent audience ID to distinguish databases.

After a restart, the desktop restores the workspace connection for its recorded owner.
The desktop cancels jobs from the previous connection and clears temporary model grants.
It preserves project files, Bot assignments, and conversation records.
An explicit disconnection revokes the database binding and removes the local reconnect credential.

Native account actions require a fresh, single-use proof of the signed-in OpenBot user.
The proof names one workspace and one action.
Another signed-in user cannot inherit the previous user's account details or model grants.

Isolated PostgreSQL tests cover restart recovery, proof scope, revocation, and concurrent reconnect responses.
Native tests cover credential storage, restored ownership, generation changes, and delayed responses during disconnection.
A live Mac check paired the existing OpenBot workspace once, then quit and reopened the installed app.
The workspace reconnected automatically, and the picker recovered its saved Astra, Low, and Standard choices.
The workspace page still required explicit model access through **Allow this VM**.

This local build also updates the installed Compose file to forward `OPENBOT_DESKTOP_INSTALLATION_ID`.
An installed release keeps its own Compose file, separately from the native app and local server image.

The subsequent read-only coding check stopped at the macOS Keychain authorization prompt.
A native stack sample located the wait in the Keychain read, before the guest started Codex.
The prompt was dismissed to permit installation of the layout updates.
A new authenticated coding turn still requires approval in the system dialog.

### Appearance and chat layout

The **CopilotKit** appearance restores the gradient frame and Atkinson font from the released v1.0.0 app.
Its saved skin ID remains `openbot`.
The other appearances keep their own frame and font.
The newer Mac titlebar spacing remains in place.

Settings → General → Appearance contains **Chat width**.
**Comfortable** preserves the existing column width for each appearance.
**Wide** permits a 72rem column, and **Full** fills the available chat area.
Both messages and the composer use the preference.
The account stores the preference in its existing JSON record, without a database migration.

The sidebar resize minimum is 220 CSS pixels.
The old calculation measured a stretched account row, so a wide sidebar could not shrink again.
The fixed calculation uses the existing fixed limits and truncates long footer labels.
Browser tests cover expansion, shrinkage, persistence, and reload at 100% and 125% scaling.

An ordinary private Bot can save `computerId` for the same VM.
Its existing file and command tools use the native target through the Computer gateway.
Assignments require the Bot owner and a registered Computer that belongs to that person.
The setup screen uses the server's assignment verdict and rejects assignments to public or external Bots.
Existing Computer tool approvals and audit wrap those operations.
A harness's internal commands need its own permission and approval mode.

## Claude Code support

The guest image installs Claude Code, but the native worker does not yet support Claude turns.
A future adapter can stream CLI output and resume a session by its explicit ID.
Model and effort flags can select settings for each resumed turn.
See the [official programmatic CLI guide](https://code.claude.com/docs/en/headless) and [CLI reference](https://code.claude.com/docs/en/cli-reference).

Anthropic permits users to sign in to an unmodified Claude Code binary hosted by another platform.
Its terms prohibit third-party applications from collecting, storing, or intermediating Claude.ai session tokens.
OpenBot must not copy host Claude account files or broker subscription tokens into a guest.
The documented `setup-token` produces a one-year subscription token, not a short-lived guest grant.
See [hosting and credential conditions](https://code.claude.com/docs/en/legal-and-compliance) and [Claude authentication](https://code.claude.com/docs/en/authentication).

A future API path can keep a user-provided API key in desktop protected storage and pass it only to the selected guest process.
That avoids guest files, but the key remains a static secret exposed to guest process memory and guest root.
Workload Identity Federation can issue short-lived API tokens after an organization configures its identity provider, service account, and federation rule.
That path uses API billing and does not exchange a consumer subscription login.
Neither path is implemented here.
See [API authentication](https://platform.claude.com/docs/en/manage-claude/authentication) and the [federation reference](https://platform.claude.com/docs/en/manage-claude/wif-reference).

## Usage for OpenBot connections

The desktop sidebar includes a Usage control above the account menu.
It shows connections configured in OpenBot, rather than accounts signed into the Mac's command-line tools.

OpenBot AI describes the installation's configured provider. Only an authorized installation administrator can see this connection.
Coding Bots shows saved ChatGPT account metadata associated with the current OpenBot owner and installation.
These sources stay separate because they can use different accounts.
The inventory works without a paired project VM.

Each request needs a fresh, short-lived, single-use server proof for the signed-in OpenBot user.
Native code validates the installation and server scope before and after reading connection metadata.
Account changes invalidate frontend results from the previous owner.
The inventory does not read credentials from Keychain, inspect host CLI accounts, or make inference requests.

Current connections do not expose a verified quota interface through this integration.
The panel therefore reports that usage is unavailable and does not invent percentages or show empty allowances as zero.
Supported subscription providers have a link to their usage page.
Future reported allowances can use the existing theme-colored bars.

Server and frontend checks passed 23 tests with 170 assertions.
Native renderer, owner filtering, worker, and command checks passed 24 tests; one live test stayed disabled.
An independent server and frontend run passed 12 tests with 108 assertions.
The local Mac app and server builds passed. Installation receipts are under `.logs/owned-usage-*`.

The installed Usage panel was checked against native IPC on November 10, 2026.
It showed the configured Claude plan under OpenBot AI and the saved ChatGPT account under Coding Bots.
Both reported unavailable quota data; no host CLI percentages appeared.

A later server-only update corrected a missing account-revision reference in the workspace Connection section.
The installed page then showed the saved ChatGPT connection and Allow this VM.
A regression test checks that a late native status response cannot expose the previous owner's identity.
The account lifecycle and coding Bot checks passed 16 tests with 48 assertions.

The home page's Business offer now uses the existing account-persisted dismissal preference.
Closing it saved `selfHostBannerDismissed: true` and removed the installed offer.
The dismissal and failure-recovery checks passed 13 tests with 46 assertions, including a fresh session and another account.
The server-only installation kept the existing native binary and signing identity.
Receipt: `.logs/connection-banner-install-receipt.json`.

Local ad hoc builds can trigger macOS Keychain permission prompts when their signing identity changes.
Pairing metadata in the database does not replace the desktop credential stored in Keychain.
VM reconnect and ChatGPT credentials use separate Keychain entries and can require separate approvals.

## Startup and shutdown presentation

Start and Quit now use `desktop/src/LifecycleProgress.tsx` for one active summary, one progress bar, and estimated remaining and elapsed time.
Step history stays under collapsed Details. Failures remain visible without opening Details.
Lifecycle status screens stay centered through Cancel and Retry; setup forms keep their existing position.

The source passed 168 App and LocalIntelligence behavior tests.
Journey and download checks passed 16 tests with 1,493 assertions.
Browser geometry checks passed nine new and nine existing cases across 720×560, 1000×800, and 1600×1000 windows.
TypeScript and Biome checks passed.
The Mac build for this presentation change is running; installation remains pending.

## Developer checks

Run the controller tests:

```sh
cargo test --manifest-path desktop/workspaces/Cargo.toml
```

The development CLI exercises the same controller as the desktop:

```sh
cargo run --manifest-path desktop/workspaces/Cargo.toml -- check
cargo run --manifest-path desktop/workspaces/Cargo.toml -- recipe > /tmp/openbot-workspace.json
cargo run --manifest-path desktop/workspaces/Cargo.toml -- create /tmp/openbot-workspace.json
cargo run --manifest-path desktop/workspaces/Cargo.toml -- prepare <workspace-id>
cargo run --manifest-path desktop/workspaces/Cargo.toml -- shell <workspace-id>
cargo run --manifest-path desktop/workspaces/Cargo.toml -- stop <workspace-id>
```

Initial live testing on this Mac created a Debian 13 ARM64 VM with four CPUs, 8 GiB memory, and a 48 GiB disk.
It installed system packages and coding tools, cloned OpenBot, installed its locked dependencies, and built the app.
A forwarded preview on host port 3030 returned HTTP 200.
A file created inside the guest did not appear in the host checkout.
These initial checks verified environment preparation. The later authenticated checks are described below.

Native worker tests also exercised commands, file reads and writes, and cancellation inside that Debian guest.
A symlink that pointed outside the project failed the file access check.
A silent `sleep` command stopped after cancellation without stopping the VM.
Separate tests checked owner boundaries, VM grants, duplicate delivery, and private session records.
These tests used synthetic credentials or no credentials. They did not use an existing host Codex login.

Deletion tests use temporary records and a fake Lima executable.
Worker tests check cancellation and the required server unregistration acknowledgement.
Permission tests check the explicit `vm-full-access` mapping and retain `workspace-write` as the default.
Those fixture tests did not delete a real VM.

A separate live controller check created and prepared a disposable Debian VM with one CPU, 2 GiB memory, and a 16 GiB disk.
It cloned and verified a small Hello World project before deletion.
The check selected the disposable VM by its exact ID and required its name to match.
The native controller stopped the running VM, deleted it, and removed its guest disk and saved record.
Before-and-after lists confirmed that every other VM record stayed identical.
This proves the controller's real deletion path.
The disposable VM was unpaired; this check did not exercise protected IPC, server unregistration, or the deletion interface.

A later live check completed OpenBot's own ChatGPT sign-in flow and created a native Codex Bot through the normal app.
Its first coding turn changed `app/src/lib/navigation.ts` and `app/tests/app-navigation.test.tsx` inside the guest.
Independent verification passed all nine navigation tests and `git diff --check`.
The guest had no Codex `auth.json` file.

The conversation picker then changed the model from GPT-6.1-Sol to GPT-6-Astra.
The next turn resumed the same guest Codex session.
The guest's `turn_context` records confirmed both selected models.
The Astra turn also recalled context from the earlier Sol turn.

The ordinary `OpenBot workspace helper` Bot (`agent_7c13950f-cf9a-4e92-b992-8903b53eb7d1`) used the same VM, `obw-3726c36bc6acb248`.
It used `computerId` without a `workspaceBot` configuration.
The normal app model called the governed `computer_run_command` tool.
The conversation showed completed command cards with `Exit 0`.
Its file and command tools ran all nine navigation tests, with no failures.

It created commit `3a1219703c1bee0a76e5e0381b07ddf3c9d5fc33` on guest branch `local/openbot-sidebar-vm-demo`.
That commit contains exactly `app/src/lib/navigation.ts` and `app/tests/app-navigation.test.tsx`.
Independent Git checks showed a clean guest working tree afterward.
The commit diff check passed, and the host checkout's HEAD stayed unchanged.
We pushed no branch and created no PR.

The helper used `--no-verify` for this commit.
At inspection, the guest had no active hooks and `core.hooksPath` was unset.
This check does not prove behavior with active hooks.
The current helper instructions forbid hook bypass.

The earlier local Mac build installed at `/Applications/OpenBot.app` on November 10, 2026, at 03:43 PST.
Startup reached ready in 32 seconds, and visual checks confirmed the centered startup interface.
The app retained the Astra model choice and paired the workspace again.
Live interface checks confirmed workspace links from native and ordinary Bot conversations, plus the manual Shell tab.

The live coding checks preceded the latest owner-binding change.
The installed build requires a fresh ChatGPT sign-in before live owner-bound authorization checks can pass.
Claude turns remain unsupported. Deletion has fixture tests and a live disposable-VM controller check, as described above.
Temporary VM lifecycle remains future work without live verification.

Startup and shutdown now share one progress view.
The active status and progress bar stay visible; Details contains the step history.
Failures stay visible without opening Details.
The initial startup screen uses the same centered layout as later starts and shutdowns.
Behavior tests cover cancellation, retry, history disclosure, and visible errors.
Browser checks cover compact, normal, and large windows, including scrolling long histories.
The updated Mac app was installed locally on November 10, 2026, at 04:16 PST.
Live startup and shutdown checks each showed one centered progress view with collapsed Details.
The server image stayed unchanged.

Workspace creation can copy up to 16 selected OpenBot skills.
The server exports only skills owned by the signed-in person or shared skills.
Each saved snapshot contains the instructions, source metadata, and a content hash.
Each snapshot is limited to 64 KiB; the combined limit is 256 KiB.
Instructions are frozen at creation. Later source edits do not change the workspace copy.
The snapshots do not copy accounts, tool grants, scripts, or referenced files.

Setup installs the copies after cloning the project and before project setup commands.
Codex discovers them under `.agents/skills/openbot-<slug>/SKILL.md`.
The installer records ownership outside the clone and refuses conflicting project files or edited managed copies.
It uses anchored directory handles, rejects symlinks and special files, and supports interrupted retries.
Local Git excludes keep generated skill copies out of ordinary commits.

A disposable Debian VM, `obw-2f34ebb71da74ecd`, verified the current installer and retry path.
Its selected `check-a-claim` snapshot came from the running OpenBot catalogue.
The native validator accepted the server-generated hash.
An actual Codex 0.163.0 `skills/list` call found the enabled repository skill with no discovery errors.
The probe used an isolated home directory and requested no inference.
The guest checkout stayed clean after installation and retry.
This verifies Codex discovery, not Claude skill loading or a model's use of the instructions.
The skill setup update was installed in the local Mac app on November 10, 2026, at 04:26 PST.
The server image and native app were rebuilt locally; nothing was published.
Live installed-app checks verified skill selection and the saved snapshot details.
The installed snapshot API returned the same content and hash used by the native VM check.
The disposable VM was then stopped and deleted through the installed app's typed-name confirmation.
Its VM directory and saved record were gone afterward. All other workspace records stayed identical.
This verifies the unpaired protected deletion path; paired worker unregistration still has fixture coverage only.

A desktop/server restart clears this prototype's in-memory workspace pairings.
The conversation model endpoint now checks that pairing before it uses a cached catalogue.
A disconnected workspace returns explicit pairing and start guidance.
The composer shows the error and a link to that Bot's workspace, with Retry available.
Re-pairing the existing OpenBot VM restored all eight Codex model choices in a live check.
The saved Astra model, low effort, and standard speed stayed intact.
Listing models does not grant ChatGPT access for a coding turn.

Usage bars use explicit theme-token tracks and fills, replacing native progress rendering.
The track uses the active skin's muted color; the fill uses its primary color.
A reported value of 90 percent or more uses the skin's destructive color.
Accessible percentages preserve the exact reported value, including zero. Missing usage has no bar.
A browser check verified fill and track colors and bar widths for all four skins in light and dark mode.
The usage color and model-picker recovery changes are installed in the local Mac app.
Live checks verified the themed Usage panel and the Astra picker after explicit workspace pairing.
No coding turn or new model-account authorization was requested during those checks.

## Connection fix: installed coding verification

After the server-only Connection fix, the existing OpenBot workspace reconnected without another pairing action.
The owner explicitly allowed the VM and approved the separate ChatGPT Keychain prompt.
The existing Codex conversation then completed a new read-only turn inside `/workspace/project`.
It reported branch `local/openbot-sidebar-vm-demo`, HEAD `3a12197`, nine passing navigation tests, and a clean working tree.
An independent guest command confirmed the branch, HEAD, and clean status.
No files were edited or committed during this check; no push or PR was created.
Evidence: `.logs/connection-runtime-readonly-after-approval.json` and `.logs/connection-runtime-guest-verification.json`.

A source-only native improvement isolates reconnect Keychain waits from worker polling and shutdown.
One process-wide restore lane bounds pending reads; stopped, expired, or stale authority results cannot reconnect.
Synthetic worker tests passed 21 cases; one live test remained disabled. A separate review checked authority-generation races.
This change is not in the installed Mac binary yet.
It does not cancel macOS dialogs or bound the separate credential read used by a coding turn.
The installed binary was deliberately preserved during the server-only update.

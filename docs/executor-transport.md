# Executor transport setup

This guide installs the Executor transport for an attended local proof of concept. It is written so a trusted local agent can perform the mechanical steps without exposing the bridge endpoint.

> **Authorization required:** This transport is intended for environments where Cursor Shell is authorized to call a separately installed local Executor service. Confirm with the user and their organization that this does not bypass an intentional MCP restriction before installing or enabling it.
>
> **Security boundary:** Executor and Pi extensions run with the user's system permissions. The descriptor endpoint is a capability token: possession grants access to the live Pi tool bridge. Never print, log, paste, share, commit, or place the endpoint in a Cursor prompt.

## Agent approval rules

A configuring agent may inspect prerequisites without approval. It must obtain explicit user approval before it:

- installs a global package or background service;
- replaces the user's installed `pi-cursor-sdk` package;
- enables Executor access to loopback/private-network endpoints;
- registers or replaces an Executor integration; or
- creates or replaces an Executor connection.

Approval for installation does not imply approval for integration or connection creation. State the exact operation and ask again before registration.

Do not use `executor.mcp.getServer` in an agent-visible session: its output includes the tokenized endpoint. Do not print the descriptor or endpoint to stdout, stderr, logs, or prompts. The guarded registration block intentionally captures individual fields in shell variables without displaying them.

## 1. Inspect prerequisites

These commands are read-only:

```bash
node --version
pi --version
pi list
command -v executor || true
executor --version 2>/dev/null || true
executor service status 2>/dev/null || true
executor daemon status 2>/dev/null || true
```

The tested Executor version is `1.6.0`. If another version is installed, review its `executor --help`, `executor install --help`, and tool schemas before continuing.

## 2. Install Executor on macOS

Ask before running this section. The CLI is distributed through npm; the optional desktop application is available through Homebrew.

```bash
npm install --global executor@1.6.0

# Optional desktop UI; not required by the bridge.
brew install --cask executor
```

The bridge endpoint is on loopback, so the supervised Executor service must be allowed to call local-network endpoints. This broadens the destinations Executor can call; enable it only on a trusted machine and keep the daemon itself loopback-bound.

Ask for explicit approval, then install the service:

```bash
EXECUTOR_ALLOW_LOCAL_NETWORK=true executor install --port 4788
executor service status
executor daemon status
```

Executor `1.6.0` persists `EXECUTOR_ALLOW_LOCAL_NETWORK` into its generated launchd service definition. Verify that before continuing:

```bash
/usr/libexec/PlistBuddy \
  -c 'Print :EnvironmentVariables:EXECUTOR_ALLOW_LOCAL_NETWORK' \
  "$HOME/Library/LaunchAgents/sh.executor.daemon.plist"
```

Expected result: the setting is `true`, the service is registered and running, and it serves a `localhost` or `127.0.0.1` URL. If the setting is missing, stop and review the installed Executor version's service documentation instead of assuming the invoking shell environment reached launchd. Do not change the daemon bind address to `0.0.0.0` for this setup.

## 3. Install this Pi extension ref

A Git ref may be a branch, tag, or commit. Remove another installed copy first; loading the npm release and Git fork together can register duplicate providers and tools.

Ask before changing Pi's package settings, then run:

```bash
pi remove npm:pi-cursor-sdk
pi install git:github.com/joshuajbrunner/pi-cursor-sdk@executor-cli-transport
```

For a reproducible installation, resolve and review the branch head, then install that immutable commit instead of the moving branch:

```bash
git ls-remote \
  https://github.com/joshuajbrunner/pi-cursor-sdk.git \
  refs/heads/executor-cli-transport

pi install git:github.com/joshuajbrunner/pi-cursor-sdk@<reviewed-full-commit-sha>
```

Pi clones a Git package under `~/.pi/agent/git/`, checks out the ref, installs production dependencies, runs the package's `prepare` build, and loads `dist/index.js`. Restart Pi after changing package sources.

## 4. Start Pi in Executor mode

The preferred configuration is the user-level `~/.pi/agent/cursor-sdk.json`; no shell exports are required. Start Pi normally and enter the explicit user command:

```bash
pi --model cursor/grok-4.6
```

```text
/cursor-executor on
```

The command saves the following setting while preserving other config fields, creates the default descriptor directory with mode `0700`, and resets the current pooled Cursor agent:

```json
{
  "local": {
    "piToolBridge": {
      "transport": "executor"
    }
  }
}
```

The nested `executor` object is optional. Add it manually only to override the defaults:

```json
{
  "local": {
    "piToolBridge": {
      "transport": "executor",
      "executor": {
        "descriptorDirectory": "/absolute/path/to/executor-bridges",
        "integrationSlug": "pi"
      }
    }
  }
}
```

The default descriptor directory is `~/.pi/agent/cursor-executor-bridges`. An optional custom `descriptorDirectory` must be absolute. The bridge refuses an existing directory with group or other access rather than changing its permissions. Executor transport is intentionally user-config only: `.pi/cursor-sdk.json` project configuration cannot enable it or redirect descriptors.

A trusted local agent may update `~/.pi/agent/cursor-sdk.json` after explicit approval, using the same shape and preserving unrelated fields. Manual edits take effect after Pi restarts; transport settings are cached for the process so an unrelated external edit cannot silently rotate a live endpoint. Invalid or unknown manually entered transport values are ignored, leaving the safe MCP default. `/cursor-executor` applies its own saved change intentionally by resetting the current pooled agent, while `/cursor-executor` and `/cursor-tools` report the effective transport and its source. Custom `descriptorDirectory` and `integrationSlug` values remain manual config fields; the command toggles only `transport`.

Environment variables remain supported as higher-precedence one-run overrides for automation and rollback:

```bash
PI_CURSOR_PI_TOOL_TRANSPORT=executor \
PI_CURSOR_EXECUTOR_DESCRIPTOR_DIR="$HOME/.local/state/pi-cursor-sdk/executor-bridges" \
PI_CURSOR_EXECUTOR_INTEGRATION_SLUG=pi \
pi --model cursor/grok-4.6
```

Only `PI_CURSOR_PI_TOOL_TRANSPORT=executor` is needed when the built-in directory and slug defaults are acceptable. Do not persist overrides in a shell profile, launch configuration, or project file without approval.

After the next Cursor-backed run starts, `/cursor-tools` reports both configured and live transport plus the current descriptor path locally. The descriptor exists only while its bridge run is live.

## 5. Register the live bridge without printing its endpoint

Registration and connection creation are separate state-changing operations. Explain that the commands will register the current live Pi bridge as an unauthenticated local MCP integration and create a user-owned Executor connection named `local`. Obtain explicit approval immediately before running them.

Run the following from a trusted local shell or Pi agent, not by copying the descriptor into a Cursor prompt. Executor `1.6.0` does not accept tool JSON on stdin, so registration necessarily exposes the endpoint briefly in the local `executor` process arguments and persists it in Executor's datastore. This is an accepted residual risk only for an attended, single-user PoC on a trusted machine. The source command and successful output do not print the endpoint; registration errors are suppressed in favor of a generic message because diagnostic payloads may echo inputs. The subshell and `EXIT` trap remove sensitive variables even when a command fails.

The block fails closed if more than one descriptor exists; use the exact path reported by `/cursor-tools` in that case. Before running it, confirm that the installed Executor schemas still match this guide:

```bash
executor tools describe executor.mcp.addServer
executor tools describe executor.coreTools.connections.create
```

After the user explicitly approves both registration and connection creation, run:

```bash
(
set -euo pipefail
umask 077
trap 'unset endpoint registration_payload registration_result connection_payload connection_result' EXIT

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
config_path="$agent_dir/cursor-sdk.json"
configured_descriptor_dir=""
if [ -f "$config_path" ]; then
  configured_descriptor_dir="$(jq -er '.local.piToolBridge.executor.descriptorDirectory // empty' "$config_path" 2>/dev/null || true)"
fi
descriptor_dir="${PI_CURSOR_EXECUTOR_DESCRIPTOR_DIR:-${configured_descriptor_dir:-$agent_dir/cursor-executor-bridges}}"
descriptor="${PI_CURSOR_EXECUTOR_DESCRIPTOR_PATH:-}"

if [ -z "$descriptor" ]; then
  descriptor_count="$(find "$descriptor_dir" -maxdepth 1 -type f -name 'executor-bridge-*.json' | wc -l | tr -d ' ')"
  if [ "$descriptor_count" -ne 1 ]; then
    echo "Expected exactly one live Executor descriptor; use /cursor-tools and set PI_CURSOR_EXECUTOR_DESCRIPTOR_PATH" >&2
    exit 1
  fi
  descriptor="$(find "$descriptor_dir" -maxdepth 1 -type f -name 'executor-bridge-*.json' -print -quit)"
fi

integration_slug="$(jq -er '.integrationSlug' "$descriptor")"
endpoint="$(jq -er '.endpointUrl' "$descriptor")"

registration_payload="$(jq -cn \
  --arg slug "$integration_slug" \
  --arg endpoint "$endpoint" \
  '{
    transport: "remote",
    name: $slug,
    description: "Local pi-cursor-sdk tool bridge",
    endpoint: $endpoint,
    remoteTransport: "streamable-http",
    slug: $slug,
    authenticationTemplate: [{slug: "none", kind: "none"}]
  }')"

if ! registration_result="$(executor call executor mcp addServer "$registration_payload" 2>/dev/null)"; then
  echo "Executor integration registration failed; inspect daemon status without dumping the payload" >&2
  exit 1
fi
registered_slug="$(printf '%s' "$registration_result" | jq -er '.data.slug')"
[ "$registered_slug" = "$integration_slug" ] || {
  echo "Executor registered a different slug than requested" >&2
  exit 1
}

connection_payload="$(jq -cn \
  --arg integration "$registered_slug" \
  '{owner: "user", name: "local", integration: $integration, template: "none"}')"
if ! connection_result="$(executor call executor coreTools connections create "$connection_payload" 2>/dev/null)"; then
  echo "Executor connection creation failed; inspect daemon status without dumping the payload" >&2
  exit 1
fi
printf '%s' "$connection_result" | jq -e '.ok == true' >/dev/null

echo "Executor bridge registered as ${registered_slug}.user.local"
)
```

If `jq` is missing, ask before installing it with `brew install jq`. Do not replace the guarded commands with diagnostics that dump the descriptor or registration payload.

## 6. Verify discovery and execution

These commands do not reveal the descriptor endpoint:

```bash
executor tools integrations
executor tools search 'intercom' --limit 10
executor tools describe pi.user.local.pi_intercom
executor call pi.user.local.pi_intercom '{"action":"list-cwd"}'
```

Executor paths may differ if a non-default integration slug, owner, or connection name was selected. Use the exact path returned by `executor tools search '<real Pi tool name>'`.

`intercom ask` remains blocking: the `executor call` command does not return until the peer replies or the bridge deadline expires.

## Endpoint rotation

The endpoint rotates when the pooled Cursor agent is recreated, including some model, thinking-level, reload, or active-tool changes. The current proof of concept does not update Executor automatically.

When `/cursor-tools` reports a new descriptor:

1. Stop using the old registration.
2. Obtain explicit approval to remove the old integration and connection and register their replacements.
3. Run the cleanup commands below for the old slug. This avoids depending on version-specific `addServer` replacement behavior.
4. Re-run the guarded registration block against the new descriptor.
5. Verify the tool with `executor tools search` and a harmless call.

Do not run this setup unattended. A production deployment needs an Executor-side watcher that treats the descriptor directory as a change feed, re-reads the current descriptor for each call, and removes registrations as soon as their descriptor disappears.

## Cleanup and rollback

Ask before removing saved Executor state. Confirm the installed cleanup schemas before acting:

```bash
executor tools describe executor.coreTools.connections.remove
executor tools describe executor.coreTools.integrations.remove
```

These commands honor the configured integration slug:

```bash
integration_slug="${PI_CURSOR_EXECUTOR_INTEGRATION_SLUG:-pi}"

executor call executor coreTools connections remove \
  "$(jq -cn --arg integration "$integration_slug" \
    '{owner:"user", name:"local", integration:$integration}')"

executor call executor coreTools integrations remove \
  "$(jq -cn --arg slug "$integration_slug" '{slug:$slug}')"
```

Return Pi to the published npm package:

```bash
pi remove git:github.com/joshuajbrunner/pi-cursor-sdk
pi install npm:pi-cursor-sdk
```

After every Executor-mode Pi process has exited, ask before deleting leftover descriptor files. Remove only the extension's matching files, then remove the directory only if it is empty:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
configured_descriptor_dir="$(jq -er '.local.piToolBridge.executor.descriptorDirectory // empty' "$agent_dir/cursor-sdk.json" 2>/dev/null || true)"
descriptor_dir="${PI_CURSOR_EXECUTOR_DESCRIPTOR_DIR:-${configured_descriptor_dir:-$agent_dir/cursor-executor-bridges}}"
if [ -d "$descriptor_dir" ]; then
  find "$descriptor_dir" -maxdepth 1 -type f -name 'executor-bridge-*.json' -delete
  rmdir "$descriptor_dir" 2>/dev/null || true
fi
```

Disable Executor transport without changing packages by leaving `PI_CURSOR_PI_TOOL_TRANSPORT` unset or setting it to `mcp`.

To remove the supervised service after approval:

```bash
executor service uninstall
```

## Troubleshooting without leaking the endpoint

- `connection_rejected` or streamable-HTTP connection failure usually means Executor still has a rotated endpoint. Re-register from the current descriptor.
- A local-network-denied or loopback-policy error means the supervised daemon did not receive `EXECUTOR_ALLOW_LOCAL_NETWORK=true`. Recheck the generated launchd service definition; do not misdiagnose it as endpoint rotation.
- No descriptor means no Executor-mode bridge run is currently live. Run `/cursor-executor` and inspect `/cursor-tools`; if environment overrides are in use, verify them in the Pi process environment.
- An insecure-directory error names the path and mode. Fix the directory intentionally with `chmod 700`; the extension does not change existing permissions.
- A ninth reconnect while tool calls are pending returns HTTP 503 with JSON-RPC `-32000`. Let the calls finish or restart the bridge run.
- Use `PI_CURSOR_PI_TOOL_BRIDGE_DEBUG=1` for Pi-side diagnostics, but never print the descriptor or call `executor.mcp.getServer` in captured logs.

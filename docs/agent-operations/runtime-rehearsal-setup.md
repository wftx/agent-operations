# Agent Operations Runtime Rehearsal Setup

This runbook creates one local CortextOS runtime for repository-free Agent Operations rehearsals. Runtime bring-up does not authorize an Agent Operations Dispatch.

## Prerequisites

- Node.js 20 or newer and the repository's npm dependencies
- a successful `npm run build`
- the Codex CLI installed and already authenticated (`codex login status`)
- no Telegram, Slack, Buzz/Nostr, PM2, tunnel, or knowledge-base credentials are required

Claude Code is also supported by CortextOS, but the Phase 12 development machine selected `codex-app-server` because Codex was already authenticated while `claude auth status` reported no authenticated session.

## Identity and local paths

- CortextOS instance: `default`
- organization: `agent-operations`
- agent: `rehearsal`
- AO runtime ID: `agent-operations/rehearsal`
- provider: `codex-app-server` (normalized by AO to `codex`)
- local state: `~/.cortextos/default`
- local working directory on this machine: `~/.cortextos/default/workspaces/rehearsal`

The agent's configured working directory must be an existing absolute path outside the Agent Operations checkout. Update `working_directory` in `orgs/agent-operations/agents/rehearsal/config.json` for the target machine. Copy the tracked rehearsal `AGENTS.md` into that external directory so Codex loads the minimal policy from its actual working root.

## Initial scaffold

The checked-in fixture was created through the supported CLI flow:

```bash
node dist/cli.js init agent-operations --instance default
node dist/cli.js add-agent rehearsal \
  --template agent \
  --runtime codex-app-server \
  --org agent-operations \
  --instance default
```

Do not rerun `add-agent` when the tracked agent directory already exists. On another checkout, run `init` to create the local instance state, create the external working directory, copy the rehearsal policy into it, and confirm that `config.json` points to it. The daemon discovers the tracked, explicitly enabled agent config. With the daemon running, `node dist/cli.js start rehearsal --instance default` can establish the instance registry entry through the supported CLI if needed.

The local `.env` and `secrets.env` placeholders remain empty and ignored. The following integration variables are intentionally not configured: `BOT_TOKEN`, `CHAT_ID`, `ACTIVITY_CHAT_ID`, and `GEMINI_API_KEY`. Provider authentication remains in Codex's existing secure login state and is not copied into the repository.

## Validate before startup

```bash
codex login status
node dist/cli.js list-agents --org agent-operations --format json --instance default
node dist/cli.js doctor --instance default
node dist/cli.js status --instance default
```

Expected pre-start state is one configured and enabled `rehearsal` agent, a valid external working directory, and no running daemon. PM2, Cloudflare, Telegram, and knowledge-base warnings are expected for this local fixture and should not be resolved solely for a rehearsal.

## Start and verify

Use the direct foreground development mode as the canonical Agent Operations
development startup; do not install PM2 for this setup:

```bash
node dist/cli.js start --foreground --instance default
```

Do not invoke another foreground or background start while this command is
initializing. The daemon must atomically claim
`~/.cortextos/default/daemon.owner` before it writes `daemon.pid`, binds
`daemon.sock`, discovers agents, starts crons, or launches Codex. A competing
daemon exits before agent/provider startup and reports the live owner's PID.

The foreground command is ready only after it prints `[daemon] Running`. In a
second terminal, perform a bounded health check within 60 seconds:

```bash
node dist/cli.js status --instance default
npm run demo:runtime-inventory
npm run dev:live-rehearsal
```

Successful readiness means all of the following are true:

- `daemon.owner/owner.json` and `daemon.pid` identify the same live PID
- exactly one `daemon.sock` exists and accepts IPC
- the IPC response identifies the `default` instance
- `status` shows exactly one running `rehearsal` lifecycle and provider PID
- there is exactly one rehearsal `codex app-server` process

If the condition is not met within 60 seconds, stop the foreground command and
investigate; do not issue another startup command against the same instance.
When running health checks from a sandboxed development tool, grant the check
the same local Unix-socket access as the startup. A sandbox-denied socket
connection can otherwise look identical to a stopped daemon even while its PID
is alive.

The inventory should be available with exactly one running `agent-operations/rehearsal` Codex runtime. The rehearsal command must be run without `--execute`; it should find the safe candidate, show `repository: none`, report the requested/effective `read-only` + `deny` + `empty` runtime policy, and report `Execution authorized: false`. Do not use the execution flags during environment setup.

For future policy-aware Dispatches, CortextOS creates a new dedicated Codex thread rather than reusing the agent's legacy `danger-full-access` thread. The restricted thread uses read-only filesystem writes, denies tool-runtime network, disables Codex environment attachment, prevents shell subprocesses from inheriting the app-server environment, and disables configured MCP servers, apps, hooks, goals/automatic continuation, memories, multi-agent tools, login shells, web search, and host dynamic tools. Codex still exposes non-login shell invocation and read access beyond the rehearsal directory; those residual capabilities are documented in ADR 0012 and must not be described as “no tools” or “no filesystem access.”

Fresh-agent admission requires a running runtime, a recent `last_idle.flag`, empty inbox and inflight queues, and either no prior injection flag or an idle timestamp at least as new as the last injection. Do not inject a ping merely to manufacture readiness evidence.

## Shutdown and restart

Press Ctrl+C in the foreground daemon terminal for a clean shutdown. Wait for
`[daemon] Shutting down`, the rehearsal stop, and process exit. Confirm that
`daemon.pid`, `daemon.sock`, and `daemon.owner` are gone before restarting with:

```bash
node dist/cli.js start --foreground --instance default
```

Do not mix foreground and background starts. Non-foreground `cortextos start`
intentionally spawns a detached daemon when PM2 is absent; the CLI parent exits
and the child may be adopted by PID 1. That is supported general CortextOS
behavior but is not the canonical AO development lifecycle because it has no
supervisor or dedicated daemon-stop command. Never infer that such a daemon is
dead from parent exit alone.

Stale-state rules:

1. prove the recorded PID and any Codex child are dead;
2. confirm no process owns `daemon.sock` or the provider's thread-writer lock;
3. let the next supported startup reclaim a dead `daemon.owner`, overwrite a
   dead `daemon.pid`, and remove a stale socket;
4. do not delete `codex-app-server-thread.json`, Codex thread-writer lock files,
   AO durable state, rehearsal history, or agent configuration.

An incomplete ownership directory is treated as an in-progress startup for a
five-second grace period, then is eligible for conservative stale recovery.
Provider active-writer conflicts halt the agent without automatic recovery;
they are not ordinary provider crashes.

The daemon and agent are intentionally not configured for boot persistence.

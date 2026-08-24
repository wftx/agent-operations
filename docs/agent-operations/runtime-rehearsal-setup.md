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

Use the direct foreground development mode; do not install PM2 for this setup:

```bash
node dist/cli.js start --foreground --instance default
```

The daemon discovers and starts the single explicitly enabled agent. In a second terminal, verify:

```bash
node dist/cli.js status --instance default
npm run demo:runtime-inventory
npm run dev:live-rehearsal
```

The inventory should be available with exactly one running `agent-operations/rehearsal` Codex runtime. The rehearsal command must be run without `--execute`; it should find the safe candidate, show `repository: none`, and report `Execution authorized: false`. Do not use the execution flags during environment setup.

Fresh-agent admission requires a running runtime, a recent `last_idle.flag`, empty inbox and inflight queues, and either no prior injection flag or an idle timestamp at least as new as the last injection. Do not inject a ping merely to manufacture readiness evidence.

## Shutdown and restart

Press Ctrl+C in the foreground daemon terminal for a clean shutdown. Restart with:

```bash
node dist/cli.js start --foreground --instance default
```

The daemon and agent are intentionally not configured for boot persistence.

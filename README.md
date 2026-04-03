# OpenClaw Codex Bridge Plugin

Persistent Codex threads for Telegram conversations in OpenClaw.

This plugin lets you:
- Bind a Telegram chat/topic to a repository.
- Run Codex from Telegram (`/codex_run ...`).
- Reuse the same Codex thread across follow-up messages.
- Attach an existing Codex thread ID from CLI sessions.
- List and rename discovered Codex sessions.

## Repository Layout

- `index.js`: plugin entrypoint (commands, tool, state, adapter, hooks)
- `openclaw.plugin.json`: plugin manifest + config schema
- `lib/`: helper modules
- `skills/codex-bridge/SKILL.md`: optional skill guidance
- `test/`: unit/integration tests

## Prerequisites

- OpenClaw installed and working
- Node.js 22+
- Telegram channel configured in OpenClaw
- Codex credentials available for `@openai/codex-sdk` / Codex CLI

## Quick Install (new OpenClaw machine)

### 1) Clone plugin into OpenClaw extensions

```bash
git clone <YOUR_GIT_URL> ~/.openclaw/extensions/codex-bridge
cd ~/.openclaw/extensions/codex-bridge
npm ci
```

### 2) Enable plugin in OpenClaw config

Edit `~/.openclaw/openclaw.json` and make sure you have:

```json
{
  "plugins": {
    "allow": ["telegram", "codex-bridge"],
    "entries": {
      "codex-bridge": {
        "enabled": true
      }
    }
  },
  "channels": {
    "telegram": {
      "capabilities": {
        "inlineButtons": "all"
      }
    }
  }
}
```

Notes:
- `inlineButtons: "all"` is required for clickable `/codex_attach` picker buttons in Telegram.
- Plugin-specific `plugins.entries.codex-bridge.config` keys can vary by OpenClaw/plugin version. Start with no custom config, then add keys only after checking:
  `openclaw plugins info codex-bridge --json`

### 3) Restart gateway

```bash
openclaw gateway restart
```

### 4) Verify plugin load

```bash
openclaw plugins info codex-bridge --json
```

Expected: command list includes `codex_bind`, `codex_run`, `codex_attach`, `codex_attach_list`, `codex_sessions`, `codex_threadids`.

## Optional One-Command Installer

From repo root:

```bash
bash scripts/install-openclaw.sh
```

This will:
- copy plugin into `~/.openclaw/extensions/codex-bridge`
- run `npm ci`
- patch `~/.openclaw/openclaw.json` (preserving existing config)
- restart OpenClaw gateway

## First Telegram Flow

1. `/codex_bind /absolute/path/to/repo`
2. `/codex_run new summarize this repo`
3. `/codex_sessions`
4. `/codex_attach` (or `/codex_attach_list`) and tap a thread
5. `/codex_run use <threadId> continue from previous context`

## Development

Run tests:

```bash
npm test
```

## Packaging/Publishing

Suggested tags:
- `v0.1.0` initial bridge
- semantic versioning for command or storage changes

## License

Add your preferred license file before publishing.

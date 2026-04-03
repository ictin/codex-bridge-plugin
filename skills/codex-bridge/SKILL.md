---
name: codex_bridge
description: Use codex_thread_run for coding tasks in Codex-enabled Telegram conversations.
metadata:
  openclaw:
    os: ["linux"]
---

# Codex Bridge

Use `codex_thread_run` when:
- the conversation is Telegram
- Codex is enabled for the conversation
- a repo is bound (or explicit cwd is provided)

Rules:
- Prefer the conversation's bound repo.
- Reuse the persisted Codex thread for follow-up tasks.
- Keep responses concise and operator-friendly.
- Do not use ACP for Codex execution in this chat.
- If approval mode is enabled and task is destructive, require approval before execution.

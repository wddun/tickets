# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Aider, etc.) working in this repo.
The full project guidance lives in `CLAUDE.md`. This file mirrors the conventions every agent should follow regardless of which tool is in use.

## House style

- **No emojis** in code, UI text, comments, commit messages, or generated files unless the user explicitly asks or there is genuinely no alternative. Prefer inline SVG icons (the codebase already uses them widely in `scanner.html`, `checkin.html`, `dashboard.html`, etc.) or plain text labels. When editing existing UI that already contains emojis, do not add more — leave the existing ones in place unless asked to clean them up.

See `CLAUDE.md` for the rest of the project structure, build commands, and architectural notes.

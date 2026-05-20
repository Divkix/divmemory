---
description: Manage divmemory persistent project memory
argument-hint: "show | add <fact> [topic] | forget <text> | consolidate | status"
---

# /memory

Manage cross-session memory stored in divmemory.

## Commands

- `show`: call `GET /context?project=<id>&max_chars=12000` and print the returned markdown.
- `add "<fact>" [topic]`: call `POST /memories` with `project_id`, `content`, and optional `topic`. The API stores it as curated with confidence `1.0`. Default topic is `general`.
- `forget "<text>"`: call `GET /memories?project=<id>&search=<text>`, show matches, ask the user to confirm, then call `DELETE /memories/:id`.
- `consolidate`: call `POST /consolidate` with `{ "project_id": "<id>" }`.
- `status`: call `GET /status?project=<id>` and report session backlog, extraction errors, active memories, curated memories, and consolidation state.

Use `Authorization: Bearer <DIVMEMORY_API_KEY>` and `DIVMEMORY_WORKER_URL` when set. Project IDs use git remote origin, or a hashed absolute-path fallback for local-only folders.

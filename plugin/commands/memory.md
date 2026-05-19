---
description: Manage divmemory persistent project memory
argument-hint: "show | add <fact> [topic] | forget <text> | consolidate | status"
---

# /memory — Persistent memory management for Droid

Manage the cross-session memory stored in divmemory.

## Usage

```
/memory show                 # Fetch and print project context to the conversation
/memory forget "<text>"      # Search and delete/archive a matching fact
/memory add "<fact>" [topic]  # Insert a curated fact manually (default topic: general)
/memory consolidate           # Trigger a consolidation pass for the current project
/memory status                # Show session count, fact count, and last sync
```

## Subcommands

### show
Fetches the project context from the Worker via `GET /context?project=<id>&max_chars=12000` and prints the returned markdown block to the Droid context. If the project has no memories yet, prints a friendly "no memories yet" message. Handles API errors gracefully.

### forget `<text>`
1. Calls `GET /memories?project=<id>&search=<text>` to find matching facts.
2. If no matches → prints "No matching memories found."
3. If exactly one match → shows the fact content and **asks for confirmation** before proceeding.
4. If multiple matches → lists them with IDs and asks the user to pick.
5. After confirmation → calls `DELETE /memories/:id`.
6. Curated facts (`curated=1`) are soft-archived (`status='archived'`).
7. auto-extracted facts (`curated=0`) are hard-deleted.

**Agent MUST always confirm with the user before any delete.**

### add `<fact>` `[topic]`
Insert a new curated fact manually:
- Calls `POST /memories`
- The API stores `curated=1`, `confidence=1.0`
- Topic defaults to `"general"` when omitted
- The fact goes through the same dedup pipeline as auto-extracted facts
- If a similar fact exists (Jaccard > 60%), the content is NOT overwritten; only `updated_at` is refreshed
- If no similar fact exists, a new memory row is inserted
- Prints success or dedup result to the user

### consolidate
Triggers a consolidation pass via `POST /consolidate` with the current project ID.
Reports the result: how many sessions were consolidated and whether any facts were merged.
Handles the case where nothing to consolidate, printing "Nothing to consolidate." when appropriate.

### status
Fetches project statistics from the Worker via `GET /status?project=<id>` and displays:
- Session count
- Active fact count
- Last sync / last seen timestamp
If the stats endpoint is unavailable, standard error handling applies.

## Authentication & URL

All API calls use:
- **Auth header:** `Authorization: Bearer <DIVMEMORY_API_KEY>`
- **Worker URL:** the `DIVMEMORY_WORKER_URL` environment variable, or `https://divmemory.divkix.workers.dev` as default
- **Project ID:** Determined the same way as the SessionEnd / SessionStart hooks (git remote origin, falling back to a hashed absolute-path local slug)

## Error handling

Every subcommand gracefully handles:
- Missing `DIVMEMORY_API_KEY` → inform the user that auth is not configured
- Worker unreachable → report network error
- Worker returns non-2xx → report the status code and response
- Empty responses → print a concise, friendly message

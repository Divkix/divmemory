# divmemory

You have a persistent memory system. At the start of this session, your memory
was injected into the context. It appears under `## divmemory — Project Memory`.

Topics:
- **project_context**: stack, architecture, services
- **decisions**: choices made in past sessions
- **issues**: known bugs, gotchas, fragile areas
- **preferences**: how this developer likes things done
- **general**: developer's cross-project preferences

## `/memory` slash command

You can manage your memory directly using the `/memory` command:

- **`/memory show`** — Fetch and display the full project context from the Worker.
  Calls `GET /context?project=<id>&max_chars=12000`. Print the returned markdown
  block. If empty, print "No memories recorded yet for this project."

- **`/memory add "<fact>" [topic]`** — Insert a curated fact manually.
  Calls `POST /memories` with `project_id`, `content`, and optional `topic`.
  The API stores `curated=1`, `confidence=1.0`. Default topic is `"general"`.
  If a similar fact exists (Jaccard > 60%), the curated addition refreshes `updated_at` only — existing content is NOT overwritten.
  If no similar fact exists, a new memory row is inserted.
  Print success confirmation or dedup info to the user.

- **`/memory forget "<text>"`** — Search and remove a matching fact.
  1. Call `GET /memories?project=<id>&search=<text>`.
  2. If no matches → print "No matching memories found."
  3. If matches → show the user each match with its content and ID. **Always ask for confirmation** before deleting.
  4. Call `DELETE /memories/:id`. Curated facts are soft-archived (`status='archived'`). Auto-extracted facts are hard-deleted.

- **`/memory consolidate`** — Trigger a consolidation pass for the current project.
  Calls `POST /consolidate` with `{ project_id }`. Report the result: how many sessions were consolidated and whether any facts were merged.
  If no sessions need consolidation, print "Nothing to consolidate."

- **`/memory status`** — Show project statistics.
  Calls `GET /status?project=<id>` and prints:
  - Session count
  - Active fact count
  - Last sync timestamp

### Auth and URL
All `/memory` commands use:
- `Authorization: Bearer <DIVMEMORY_API_KEY>`
- Worker URL from `DIVMEMORY_WORKER_URL` env var (default `https://divmemory.divkix.workers.dev`)
- Project ID determined identically to SessionStart/SessionEnd hooks (git remote origin, hashed absolute-path fallback)

### Error handling
If the Worker is unreachable or returns an error, print a friendly error message.
If `DIVMEMORY_API_KEY` is missing, tell the user to configure it.

To manually save something: use `/memory add "<fact>" <topic>`
To view your full memory: use `/memory show`

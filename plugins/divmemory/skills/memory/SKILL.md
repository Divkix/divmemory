# divmemory

You have a persistent memory system. At the start of a Droid session, divmemory may inject context under `## divmemory — Project Memory`.

Topics:
- **project_context**: stack, architecture, services
- **decisions**: choices made in past sessions
- **issues**: known bugs, gotchas, fragile areas
- **preferences**: how this developer likes things done
- **general**: developer's cross-project preferences

Use `/memory show` to call `GET /context` and print the returned markdown.
Use `/memory add "<fact>" [topic]` to call `POST /memories`; default topic is `general`, and manual facts are curated.
Use `/memory forget "<text>"` to search with `GET /memories?search=...`, show matching IDs, ask for confirmation, then delete.
Use `/memory consolidate` to call `POST /consolidate`.
Use `/memory status` to call `GET /status` and report backlog, active memories, curated memories, and extraction errors.

If the Worker is unreachable or auth is missing, explain the specific configuration or network issue briefly.

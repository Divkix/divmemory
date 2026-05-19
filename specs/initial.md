# divmemory — Spec v0.2

> Persistent cross-session memory layer for coding agents.
> Phase 1: Factory Droid plugin. Phase 2: OpenCode. Phase 3: Claude Code.

---

## 1. Overview

`divmemory` is a Droid plugin + Cloudflare Workers backend that gives your coding
agents a persistent second brain. At session end, the full conversation is
extracted into structured memory facts and stored in Cloudflare D1. At session
start, the relevant memory is injected directly into the agent context via the
SessionStart hook's stdout mechanism. Zero file editing, zero git noise.

### 1.1 Goals

- Full session continuity: agent knows what you built, decided, and broke last time
- Human-readable memory: you can read and edit it via the web UI
- Tool-agnostic backend: same CF Worker API serves Droid, OpenCode, Claude Code
- Cheap to run: Kimi K2.6 Turbo via Fireworks Firepass for extraction (not frontier models)
- One-command install, zero manual hook config
- No file pollution: context injected directly, never touches AGENTS.md

### 1.2 Non-goals (Phase 1)

- Claude.ai / ChatGPT integration
- RAG / vector search (flat injection only, token-capped)
- Real-time mid-session memory updates
- Team/shared memory (single-user only for now)

---

## 2. Repo Structure (Monorepo)

```
divmemory/                        # GitHub: divkix/divmemory
├── package.json                  # bun workspaces root
├── worker/                       # CF Worker (Hono + Drizzle)
│   ├── package.json
│   ├── src/
│   │   ├── index.ts              # Hono router
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle schema
│   │   │   └── migrations/
│   │   ├── routes/
│   │   │   ├── ingest.ts
│   │   │   ├── context.ts
│   │   │   ├── consolidate.ts
│   │   │   ├── memories.ts
│   │   │   └── webui.tsx         # Hono JSX pages
│   │   ├── extract.ts            # Firepass extraction logic
│   │   ├── dedup.ts              # Token-overlap deduplication
│   │   └── auth.ts               # API key + web password auth
│   ├── wrangler.jsonc
│   └── vitest.config.ts
├── plugin/                       # Droid plugin (the marketplace entry)
│   ├── .factory-plugin/
│   │   └── plugin.json
│   ├── hooks/
│   │   ├── hooks.json
│   │   ├── session-end.mjs
│   │   └── session-start.mjs
│   ├── commands/
│   │   └── memory.md
│   ├── skills/
│   │   └── memory/
│   │       └── SKILL.md
│   └── README.md
├── cli/                          # Bootstrap CLI (npm: divmemory-bootstrap)
│   ├── package.json
│   ├── src/
│   │   └── index.ts
│   └── vitest.config.ts
└── specs/
    └── initial.md                # This file
```

**Distribution**: The repo itself is the marketplace. Users add
`https://github.com/divkix/divmemory` as a marketplace, then install the
`divmemory` plugin. CLI publishes as `divmemory-bootstrap` on npm.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  LOCAL (your machine)                    │
│                                                          │
│  Droid Plugin (divmemory)                                │
│  ├── hooks/session-end.mjs    ← parses JSONL, POSTs     │
│  ├── hooks/session-start.mjs  ← fetches context, stdout │
│  │                               → Droid injects directly │
│  ├── commands/memory.md       ← /memory slash command   │
│  └── skills/memory/SKILL.md   ← agent knows about memory│
│                                                          │
│  Bootstrap CLI (run once)                                │
│  npx divmemory-bootstrap                                 │
│  └── reads past ~/.factory/ sessions                     │
│      → batches to CF Worker /ingest                      │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTPS (POST /ingest, GET /context)
┌───────────────────────▼─────────────────────────────────┐
│              CF WORKER  (Hono + Drizzle)                  │
│                                                          │
│  Routes:                                                 │
│  POST /ingest        ← receive session transcript        │
│  GET  /context       ← return formatted context block    │
│  POST /consolidate   ← consolidation trigger (internal)  │
│  GET  /memories      ← JSON list (for UI)                │
│  DELETE /memories/:id← delete a memory entry            │
│  PATCH /memories/:id ← edit a memory entry              │
│  GET  /              ← web UI (Hono JSX)                │
│  POST /login         ← web UI auth (cookie)             │
│                                                          │
│  Internal:                                               │
│  extractFacts()      ← calls Kimi K2.6 via Firepass      │
│  deduplicateFacts()  ← token-overlap merge              │
│  consolidate()       ← compresses N sessions into master │
│  Cron (daily 3am)    ← auto-consolidation pass           │
└───────────────────────┬─────────────────────────────────┘
                        │
              ┌─────────▼────────┐
              │  Cloudflare D1   │
              │  (SQLite)        │
              │                  │
              │  sessions        │
              │  memories        │
              │  projects        │
              └──────────────────┘
```

---

## 4. Plugin Structure

### 4.1 Plugin Manifest — `plugin/.factory-plugin/plugin.json`

```json
{
  "name": "divmemory",
  "description": "Persistent cross-session memory for Droid. Extracts facts from each session and injects them back on start.",
  "version": "0.1.0",
  "author": {
    "name": "divkix"
  }
}
```

### 4.2 Hook Config — `plugin/hooks/hooks.json`

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${DROID_PLUGIN_ROOT}/hooks/session-end.mjs",
          "timeout": 90
        }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${DROID_PLUGIN_ROOT}/hooks/session-start.mjs",
          "timeout": 30
        }]
      }
    ]
  }
}
```

---

## 5. Hook Scripts

### 5.1 SessionEnd — `plugin/hooks/session-end.mjs`

**Receives** (via stdin, actual Droid hook format):

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/div/.factory/sessions/-Users-divkix-GitHub-my-app/abc123.jsonl",
  "cwd": "/Users/div/projects/my-app",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

**Project identification**: Run `git remote get-url origin` from `cwd`. Use the
remote URL as the canonical project ID (e.g., `github.com/divkix/my-app`). If
no git remote (scratch directory), fall back to `path.basename(cwd)`.

**Conversation extraction logic**:

1. Read `transcript_path` line by line (JSONL)
2. Parse each line as JSON; skip non-message types (`session_start` etc.)
3. For each message:
   - **Keep**: `content` blocks with `type: "text"` from `user` and `assistant`
messages
   - **Strip**: `type: "thinking"` blocks, `type: "tool_use"` blocks,
`system-reminder` content (lines containing skill lists and environment info),
`system-notification` blocks
4. Concatenate kept text blocks with double newlines between turns
5. Prepend `User: ` and `Assistant: ` prefixes to turns for extraction clarity

**Logic**:
1. Determine project ID (git remote or dirname fallback)
2. Parse transcript and build clean conversation text
3. `POST https://divmemory.divkix.workers.dev/ingest` with:

   ```json
   {
     "session_id": "abc123",
     "project_id": "github.com/divkix/my-app",
     "project_name": "my-app",
     "source": "droid",
     "conversation": "<cleaned conversation text>",
     "metadata": {}
   }
   ```

4. Log result to stderr (visible in Droid debug mode)
5. Exit 0 always (non-blocking — memory errors never fail the session)

**Auth**: reads `DIVMEMORY_API_KEY` from env.

### 5.2 SessionStart — `plugin/hooks/session-start.mjs`

**Receives** (via stdin, actual Droid SessionStart hook format):

```json
{
  "session_id": "new123",
  "transcript_path": "...",
  "cwd": "/Users/div/projects/my-app",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

**Logic**:

1. Determine project ID (same git remote logic as SessionEnd)
2. `GET https://divmemory.divkix.workers.dev/context?project=<project_id>&max_chars=12000`
3. The Worker returns a formatted context block (plain text, 12K char capped)
4. Write the context text to **stdout** (not a file)
5. Exit 0

**How injection works**: For `SessionStart` hooks, stdout with exit code 0 is
automatically injected into Droid's session context. Alternatively, output JSON
with `hookSpecificOutput.additionalContext`. No AGENTS.md editing. No file
pollution. No git noise.

**Context format** (returned by Worker, printed to stdout):

```markdown
## divmemory — Project Memory
_Last updated: 2026-05-18 09:41 UTC | 15 facts loaded_

### Project Context
- Stack: Hono + Cloudflare Workers + D1 + Better Auth
- Auth provider: Better Auth with GitHub OAuth
- Database: PlanetScale Postgres via Hyperdrive

### Recent Decisions
- 2026-05-15: Switched from Drizzle to Hono's built-in validator
- 2026-05-12: Dropped Resend, using Cloudflare Email Routing instead

### Known Issues / Watch Out
- D1 batch writes occasionally timeout under heavy load — use retry logic
- Better Auth session tokens expire in 7 days, not configurable

### Your Preferences (this project)
- Always use fish shell syntax for any shell examples
- TypeScript strict mode, no `any`
- Test with Vitest, not Jest
```

---

## 6. CF Worker — Backend (Hono + Drizzle)

### 6.1 D1 Schema

```sql
-- Projects table (id = git remote URL or dirname)
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT,
  session_count INTEGER DEFAULT 0,
  last_seen   INTEGER,
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Sessions log (raw_text kept until consolidated)
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  source        TEXT NOT NULL,    -- 'droid' | 'opencode' | 'claude-code'
  raw_text      TEXT,
  token_count   INTEGER,
  consolidated  INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch())
);

-- Memory entries
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  topic         TEXT NOT NULL,    -- 'project_context' | 'decisions' | 'issues' | 'preferences' | 'general'
  content       TEXT NOT NULL,
  source_session TEXT,
  confidence    REAL DEFAULT 1.0,
  created_at    INTEGER DEFAULT (unixepoch()),
  updated_at    INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_memories_project_topic ON memories(project_id, topic);
CREATE INDEX idx_sessions_project ON sessions(project_id, consolidated);
```

### 6.2 Memory Topics

| Topic | What goes here |
|---|---|
| `project_context` | Stack, architecture, services, repo structure |
| `decisions` | Anything decided: lib choices, approach changes, dropped ideas |
| `issues` | Bugs hit, gotchas, things that broke, watch-outs |
| `preferences` | How you like things: style, tools, patterns specific to this project |
| `general` | Cross-project: your global preferences, communication style, how you work |

### 6.3 Routes

#### `POST /ingest`

Auth: `Authorization: Bearer <DIVMEMORY_API_KEY>`

Body:

```json
{
  "session_id": "string",
  "project_id": "github.com/divkix/my-app",
  "project_name": "my-app",
  "source": "droid",
  "conversation": "string",
  "metadata": {}
}
```

Flow:

1. Upsert project into `projects` table
2. Insert session into `sessions` table (raw_text = conversation)
3. Call `extractFacts(conversation, projectId)` → Firepass (async via `ctx.waitUntil`)
   - On Firepass failure: session is stored, no facts extracted, ingest still returns 200
   - Extraction failures retried on next consolidation trigger
4. Deduplicate returned facts against existing `memories` using token-overlap similarity
   - If similarity > 60% with an existing fact: update `updated_at` timestamp
   - Replace `content` only if new fact has higher `confidence`
   - If no match: insert as new memory
5. Increment `projects.session_count`
6. **Auto-consolidation trigger**: if unconsolidated session count ≥ 5 for this project,
   fire `consolidate(projectId)` async via `ctx.waitUntil`
7. Return `{ ok: true, facts_written: N }` (N may be 0 on extraction failure)

#### `GET /context`

Query params: `?project=<project_id>&max_chars=12000`

Auth: `Authorization: Bearer <DIVMEMORY_API_KEY>`

Flow:

1. Fetch all memories for project, ordered by `topic, updated_at DESC`
2. **Truncation strategy** (ensures balanced coverage):
   - Allocate ~500 chars guaranteed to each of the 5 topics (2500 chars total)
   - Fill remaining ~9500 chars with newest memories across all topics
3. Format into the context block (see 5.2 output format)
4. Return `text/plain` response

#### `POST /consolidate` (auto-triggered + cron)

Auth: `Authorization: Bearer <DIVMEMORY_API_KEY>`

Reads all non-consolidated sessions for a project, runs a consolidation
extraction pass over them (same Firepass prompt but fed existing memories + new
session content), updates memories, marks sessions as consolidated, prunes
`raw_text` from old sessions (keep metadata only).

**Triggers**:

- **Per-ingest**: When unconsolidated sessions ≥ 5 for a project
- **Cron**: Daily 3am UTC — consolidates any project with ≥ 2 unconsolidated sessions

**Failure handling**: On Firepass failure during consolidation, sessions stay
unconsolidated. They retry on the next trigger. Raw text remains in D1 until
successful consolidation.

#### `GET /memories`

Auth: Cookie-based (web UI) or `Authorization: Bearer <DIVMEMORY_API_KEY>` (API)

Returns JSON of all memories, grouped by project and topic.

#### `PATCH /memories/:id`

Auth: Cookie-based or bearer token

Body: `{ "content": "updated fact text", "topic": "decisions" }`

#### `DELETE /memories/:id`

Auth: Cookie-based or bearer token

Hard delete a single memory entry.

#### `POST /login`

Body: `{ "password": "..." }`

Verifies against `DIVMEMORY_WEB_PASSWORD` env var. Sets a signed HTTP-only
cookie on success. Used by web UI.

#### `GET /` — Web UI (Hono JSX)

Server-rendered with Hono JSX. Zero client-side JavaScript required.

Shows:

- **Login form** (if not authenticated via cookie)
- **Project list** (sidebar)
- **Memory entries** grouped by topic (main panel)
- **Edit button** → inline form, POSTs to PATCH endpoint
- **Delete button** → form POST to DELETE endpoint
- **Consolidate button** → POST /consolidate (only shown when 2+ unconsolidated sessions)
- **Session log** (last 20 sessions, token count, date)

All interactions are standard form POSTs — no fetch/JS needed.

---

## 7. Extraction — Kimi K2.6 via Firepass

### 7.1 Extraction Prompt

```
You are a memory extraction system for a coding agent.
Given a conversation between a developer and an AI coding assistant,
extract facts worth remembering for future sessions.

Output ONLY valid JSON. No preamble, no markdown fences.

Schema:
{
  "facts": [
    {
      "topic": "project_context" | "decisions" | "issues" | "preferences" | "general",
      "content": "One clear, self-contained sentence or short paragraph.",
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- Extract only stable, reusable facts. Skip one-off debugging noise.
- "decisions" = deliberate choices made this session (library picked, approach chosen, thing dropped)
- "issues" = bugs hit, gotchas discovered, things that are broken or fragile
- "project_context" = tech stack, architecture, services, env setup
- "preferences" = how the developer likes things done (style, tooling, patterns)
- "general" = cross-project things (developer's global preferences, workflow)
- Each fact must be standalone. Someone reading it without the conversation must understand it.
- Max 15 facts per session. Prioritize high signal.
- Confidence < 0.7 = skip it.

Conversation:
<CONVERSATION>
```

### 7.2 Firepass API Call

```typescript
const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.FIREWORKS_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: env.FIREWORKS_MODEL,  // "accounts/fireworks/routers/kimi-k2p6-turbo"
    max_tokens: 2048,
    temperature: 0.1,
    messages: [
      { role: "user", content: prompt }
    ]
  })
});
```

Model string is configured via `FIREWORKS_MODEL` env var, defaulting to
`accounts/fireworks/routers/kimi-k2p6-turbo`.

### 7.3 Deduplication Logic

Before inserting a new fact, check against existing memories for the same
project + topic:

1. Tokenize both the new fact and each existing fact (lowercase, split on whitespace)
2. Compute Jaccard similarity: `|intersection| / |union|`
3. If similarity > 0.6: this is a duplicate
   - Always update `updated_at` to now (keeps fact fresh)
   - Replace `content` only if `new.confidence > old.confidence`
4. If similarity ≤ 0.6: insert as new memory

### 7.4 Consolidation Pass

Same extraction prompt, but fed:
- All existing memories for the project (as context)
- All unconsolidated session conversations

Goal: merge duplicates, remove stale entries, update changed facts. Runs async
via `ctx.waitUntil` — doesn't block the ingest response.

---

## 8. Bootstrap CLI

Package: `divmemory-bootstrap` on npm. Node-compiled (portable, no runtime
dependency on bun).

```
Usage:
  npx divmemory-bootstrap [--dir ~/.factory] [--limit 50] [--dry-run]

Options:
  --dir       Path to Droid sessions directory (default: ~/.factory)
  --limit     Max past sessions to ingest (default: 50, newest first)
  --dry-run   Parse and print what would be sent, don't POST
  --api-key   Override DIVMEMORY_API_KEY env var
  --worker    Override worker URL (default: https://divmemory.divkix.workers.dev)
```

Flow:

1. Find all `*.jsonl` files in `~/.factory/sessions/`
2. Sort by mtime, take newest N
3. For each: parse JSONL → extract conversation → determine project ID → POST `/ingest`
4. Rate-limit: 1 req/sec to avoid hammering Firepass
5. Print progress: `[12/50] my-app session 2026-05-10 ✓ (8 facts extracted)`

---

## 9. Slash Command — `/memory`

File: `plugin/commands/memory.md`

```markdown
# /memory

Interact with your divmemory second brain.

## Usage

/memory show              — Print current project's memory to context
/memory forget "<text>"   — Delete a memory fact matching this text
/memory add "<text>" [topic] — Manually add a fact (topic optional, defaults to general)
/memory consolidate       — Trigger a consolidation pass now
/memory status            — Show session count, fact count, last sync
```

The slash command calls the same CF Worker API. The agent runs the appropriate
HTTP call and prints the result.

---

## 10. Agent Skill — `plugin/skills/memory/SKILL.md`

```markdown
# divmemory

You have a persistent memory system. At the start of this session, your memory
was injected into the context. It appears under ## divmemory — Project Memory.

Topics:
- project_context: stack, architecture, services
- decisions: choices made in past sessions
- issues: known bugs, gotchas, fragile areas
- preferences: how this developer likes things done
- general: developer's cross-project preferences

To manually save something: use /memory add "<fact>" <topic>
To view your full memory: use /memory show
```

---

## 11. Configuration

### 11.1 Environment Variables

| Variable | Where set | Purpose |
|---|---|---|
| `DIVMEMORY_API_KEY` | Shell profile / Droid env | Auth token for Worker API (bearer token) |
| `DIVMEMORY_WORKER_URL` | Shell profile (optional) | Override worker URL (default: `https://divmemory.divkix.workers.dev`) |
| `FIREWORKS_API_KEY` | CF Worker secret | Firepass auth |
| `FIREWORKS_MODEL` | CF Worker env | Model string (default: `accounts/fireworks/routers/kimi-k2p6-turbo`) |
| `DIVMEMORY_WEB_PASSWORD` | CF Worker secret | Password for web UI login |

### 11.2 Auth Summary

- **Hooks + CLI**: `Authorization: Bearer <DIVMEMORY_API_KEY>` header
- **Web UI**: Login form → cookie-based (password verified against `DIVMEMORY_WEB_PASSWORD`)
  Two separate credentials so the web UI can be accessed from any device without
  exposing the programmatic API key.

---

## 12. Testing Strategy

All tests use **Vitest**. Test-driven development — write tests first, then
implementation.

### Worker tests (`worker/`)

- **Route handlers**: Unit test each route. Mock Firepass responses. Use D1
  local binding for in-memory SQLite.
- **Extraction**: Mock Firepass API, verify extracted facts are parsed and
  upserted correctly.
- **Deduplication**: Unit test the token-overlap logic with known fact pairs.
- **Auth**: Test that unauthenticated requests get 401, wrong password gets
  login error, valid password sets cookie.

### Hook script tests (`plugin/`)

- **session-end.mjs**: Pipe mock JSONL to stdin, verify generated POST body and
  project ID extraction.
- **session-start.mjs**: Mock the context API response, verify stdout output
  format.
- **Edge cases**: Empty session, missing git remote, huge sessions, malformed
  JSONL.

### CLI tests (`cli/`)

- **JSONL parsing**: Verify extraction from real session files
- **Batch logic**: Verify sorting, rate limiting, progress output
- **Error handling**: Network failures, invalid API keys

---

## 13. Ship Order

### Phase 1 — Foundation (build this first)

- [ ] Monorepo setup (bun workspaces, biome, vitest configs)
- [ ] D1 schema + Drizzle migrations
- [ ] CF Worker: `/ingest`, `/context`, `/login` routes
- [ ] Extraction prompt + Firepass integration (with failure handling)
- [ ] Deduplication logic
- [ ] `session-end.mjs` hook script (conversation extraction + POST)
- [ ] `session-start.mjs` hook script (context fetch + stdout injection)
- [ ] `hooks.json` + `plugin.json`
- [ ] Local test: `droid plugin install ./plugin` + verify hooks fire

### Phase 2 — Polish

- [ ] Bootstrap CLI (`npx divmemory-bootstrap`)
- [ ] Consolidation pass (auto-trigger at 5+ sessions + daily cron)
- [ ] `/memory` slash command
- [ ] Agent skill SKILL.md
- [ ] Web UI (Hono JSX, server-rendered)

### Phase 3 — OpenCode

- [ ] Session reader for OpenCode SQLite (`~/.opencode/opencode.db`)
- [ ] Hook equivalent for OpenCode (check if it supports hooks or use wrapper)
- [ ] Same Worker API, new `source: "opencode"` tag

### Phase 4 — Expand

- [ ] Claude Code (JSONL reader + hook)
- [ ] Plugin marketplace listing refinement
- [ ] README + setup docs

---

## 14. Key Design Decisions (Resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | Repo structure | Monorepo: `worker/`, `plugin/`, `cli/` |
| 2 | Project ID | Git remote origin, dirname fallback |
| 3 | Memory injection method | SessionStart hook stdout → direct context injection. NO AGENTS.md editing |
| 4 | Token / char budget | 12K chars cap, min 500 chars per topic guarantee |
| 5 | Merge strategy | Token-overlap similarity (>60%), update if confidence higher, always refresh `updated_at` |
| 6 | Firepass model | `accounts/fireworks/routers/kimi-k2p6-turbo` (env-configurable) |
| 7 | Conversation extraction | Keep text blocks, strip thinking/tool_use/system-reminder |
| 8 | API auth | Single `DIVMEMORY_API_KEY` bearer token |
| 9 | Web UI auth | Separate `DIVMEMORY_WEB_PASSWORD` + cookie |
| 10 | Plugin distribution | GitHub repo as marketplace |
| 11 | Worker framework | Hono + Drizzle |
| 12 | Web UI tech | Hono JSX (server-rendered, zero client JS) |
| 13 | Bootstrap CLI | Node-compiled, `npx divmemory-bootstrap` |
| 14 | Consolidation triggers | Auto at 5+ sessions (per ingest), cron at 2+ (daily 3am) |
| 15 | Firepass failures | Best-effort extraction, raw text always saved, retry on next consolidation |
| 16 | Testing | Vitest, TDD, comprehensive across all packages |

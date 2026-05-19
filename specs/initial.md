# divmemory — Spec v0.1

> Persistent cross-session memory layer for coding agents.  
> Phase 1: Factory Droid plugin. Phase 2: OpenCode. Phase 3: Claude Code.

---

## 1. Overview

`divmemory` is a Droid plugin + Cloudflare Workers backend that gives your coding
agents a persistent second brain. At session end, the full conversation is
extracted into structured memory facts and stored in Cloudflare D1. At session
start, the relevant memory is injected back into the agent context automatically
via `AGENTS.md`. Zero manual config — `droid plugin install divmemory` and it
just works.

### 1.1 Goals

- Full session continuity: agent knows what you built, decided, and broke last time
- Human-readable memory: you can read and edit it via the web UI
- Tool-agnostic backend: same CF Worker API serves Droid, OpenCode, Claude Code
- Cheap to run: Kimi K2.6 Turbo via Fireworks Firepass for extraction (not frontier models)
- One-command install, zero manual hook config

### 1.2 Non-goals (Phase 1)

- Claude.ai / ChatGPT integration
- RAG / vector search (flat injection only, token-capped)
- Real-time mid-session memory updates
- Team/shared memory (single-user only for now)

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  LOCAL (your machine)                    │
│                                                          │
│  Droid Plugin (divmemory)                                │
│  ├── hooks/hooks.json    ← auto-registered on install    │
│  ├── hooks/session-end.mjs   ← reads transcript, POSTs  │
│  ├── hooks/session-start.mjs ← fetches context, writes  │
│  │                              AGENTS.md                │
│  ├── commands/memory.md  ← /memory slash command         │
│  └── skills/memory/SKILL.md ← agent knows about memory  │
│                                                          │
│  Bootstrap CLI (run once)                                │
│  npx divmemory-bootstrap                                 │
│  └── reads past ~/.factory/ sessions                     │
│      → batches to CF Worker /ingest                      │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTPS (POST /ingest, GET /context)
┌───────────────────────▼─────────────────────────────────┐
│              CF WORKER  (divmemory-worker)                │
│              deployed via vinext                          │
│                                                          │
│  Routes:                                                 │
│  POST /ingest        ← receive session transcript        │
│  GET  /context       ← return formatted context block    │
│  POST /consolidate   ← manual consolidation trigger      │
│  GET  /memories      ← JSON list (for UI)                │
│  DELETE /memories/:id← delete a memory entry            │
│  GET  /              ← web UI (memory browser)           │
│                                                          │
│  Internal:                                               │
│  extractFacts()      ← calls Kimi K2.6 via Firepass      │
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

## 3. Plugin Structure

```
divmemory/
├── .factory-plugin/
│   └── plugin.json              # Plugin manifest
├── hooks/
│   ├── hooks.json               # Hook event config (auto-registered)
│   ├── session-end.mjs          # SessionEnd handler
│   └── session-start.mjs        # SessionStart handler
├── commands/
│   └── memory.md                # /memory slash command
├── skills/
│   └── memory/
│       └── SKILL.md             # Agent awareness skill
└── README.md
```

### 3.1 Plugin Manifest — `.factory-plugin/plugin.json`

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

### 3.2 Hook Config — `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "node ${DROID_PLUGIN_ROOT}/hooks/session-end.mjs",
          "timeout": 60
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

## 4. Hook Scripts

### 4.1 SessionEnd — `hooks/session-end.mjs`

**Receives** (via stdin, JSON):
```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/div/.factory/sessions/abc123.jsonl",
  "project_dir": "/Users/div/projects/my-app",
  "model": "kimi-k2",
  "token_usage": { "input": 12000, "output": 3400 }
}
```

**Logic**:
1. Read `transcript_path` → parse JSONL → extract user+assistant messages
2. Build conversation text (strip tool use noise, keep code + prose)
3. `POST https://divmemory.divkix.workers.dev/ingest` with:
   ```json
   {
     "session_id": "abc123",
     "project": "/Users/div/projects/my-app",
     "project_name": "my-app",
     "source": "droid",
     "conversation": "<full text>",
     "metadata": { "model": "kimi-k2", "tokens": 15400 }
   }
   ```
4. Log result to stderr (Droid shows hook stderr in debug mode)
5. Exit 0 always (non-blocking — don't fail the session for memory errors)

**Auth**: reads `DIVMEMORY_API_KEY` from env (set in shell profile or
`~/.factory/settings.json` env block).

### 4.2 SessionStart — `hooks/session-start.mjs`

**Receives** (via stdin, JSON):
```json
{
  "session_id": "new123",
  "project_dir": "/Users/div/projects/my-app",
  "is_resume": false
}
```

**Logic**:
1. `GET https://divmemory.divkix.workers.dev/context?project=my-app&limit=200lines`
2. Receive formatted context block (plain text, token-capped)
3. Write to `$FACTORY_PROJECT_DIR/AGENTS.md` under a `## divmemory` section
   - If section exists: replace it
   - If `AGENTS.md` doesn't exist: create it with just the section
4. Exit 0

**Output format injected into AGENTS.md**:
```markdown
## divmemory — Project Memory
_Last updated: 2026-05-18 09:41 UTC_

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

## 5. CF Worker — Backend

### 5.1 D1 Schema

```sql
-- Projects table
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,   -- slug, e.g. "my-app"
  name        TEXT NOT NULL,
  path        TEXT,               -- local path hint
  session_count INTEGER DEFAULT 0,
  last_seen   INTEGER,            -- unix timestamp
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Sessions log (rolling window, pruned after consolidation)
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  source        TEXT NOT NULL,    -- 'droid' | 'opencode' | 'claude-code'
  raw_text      TEXT,             -- full conversation (kept until consolidation)
  token_count   INTEGER,
  consolidated  INTEGER DEFAULT 0, -- bool: included in master?
  created_at    INTEGER DEFAULT (unixepoch())
);

-- Memory entries (extracted facts, keyed by topic + project)
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,   -- uuid
  project_id  TEXT NOT NULL REFERENCES projects(id),
  topic       TEXT NOT NULL,      -- 'project_context' | 'decisions' | 'issues' | 'preferences' | 'general'
  content     TEXT NOT NULL,      -- the fact, plain text
  source_session TEXT,            -- which session this came from
  confidence  REAL DEFAULT 1.0,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_memories_project_topic ON memories(project_id, topic);
CREATE INDEX idx_sessions_project ON sessions(project_id, consolidated);
```

### 5.2 Memory Topics

Every extracted fact gets tagged to exactly one topic:

| Topic | What goes here |
|---|---|
| `project_context` | Stack, architecture, services, repo structure |
| `decisions` | Anything decided: lib choices, approach changes, dropped ideas |
| `issues` | Bugs hit, gotchas, things that broke, watch-outs |
| `preferences` | How you like things: style, tools, patterns specific to this project |
| `general` | Cross-project: your global preferences, communication style, how you work |

### 5.3 Routes

#### `POST /ingest`

Auth: `Authorization: Bearer <DIVMEMORY_API_KEY>`

Body:
```json
{
  "session_id": "string",
  "project": "string",       // project path or name
  "project_name": "string",
  "source": "droid",
  "conversation": "string",  // full conversation text
  "metadata": {}
}
```

Flow:
1. Upsert project into `projects` table
2. Insert session into `sessions` table (raw_text = conversation)
3. Call `extractFacts(conversation, projectId)` → Kimi K2.6 via Firepass
4. Upsert returned facts into `memories` (merge/replace by topic+content similarity)
5. Increment `projects.session_count`
6. If `session_count % 5 === 0` → trigger `consolidate(projectId)` async (via `ctx.waitUntil`)
7. Return `{ ok: true, facts_written: N }`

#### `GET /context`

Query params: `?project=my-app&limit=200` (limit = max lines)

Flow:
1. Fetch all memories for project, ordered by `topic, updated_at DESC`
2. Format into the AGENTS.md block (see 4.2)
3. Truncate to `limit` lines if over budget
4. Return plain text

#### `POST /consolidate` (internal / manual)

Reads all non-consolidated sessions for a project, runs a consolidation
extraction pass over them, updates memories, marks sessions as consolidated,
prunes raw_text from old sessions (keep metadata only).

#### `GET /memories` (UI / debug)

Returns JSON of all memories, grouped by project and topic. Used by the web UI.

#### `DELETE /memories/:id`

Hard delete a single memory entry. Used from web UI.

#### `GET /` — Web UI

Simple read/edit UI built with vinext. Shows:
- Project list (sidebar)
- Memory entries grouped by topic (main panel)
- Edit button on each entry (inline edit → PATCH /memories/:id)
- Delete button
- "Consolidate now" button → POST /consolidate
- Session log (last 20 sessions, token count, date)

---

## 6. Extraction — Kimi K2.6 via Firepass

### 6.1 Extraction Prompt

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

### 6.2 Fireworks Firepass API Call

```typescript
const response = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${env.FIREWORKS_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "accounts/fireworks/models/kimi-k2-turbo",  // adjust to exact Firepass model string
    max_tokens: 2048,
    temperature: 0.1,   // low temp for deterministic extraction
    messages: [
      { role: "user", content: prompt }
    ]
  })
});
```

### 6.3 Consolidation Pass

Same extraction prompt, but fed the existing memory entries (not raw sessions) +
any new session content. Goal: merge duplicates, remove stale entries, update
changed facts. Runs async via `ctx.waitUntil` — doesn't block the ingest response.

---

## 7. Bootstrap CLI

Package: `divmemory-bootstrap` (or `npx divmemory-bootstrap`)

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
1. Find all `*.jsonl` files in `~/.factory/sessions/` (or wherever Droid stores them)
2. Sort by mtime, take newest N
3. For each: parse JSONL → extract conversation → POST `/ingest` with `source: "droid"`
4. Rate-limit: 1 req/sec to avoid hammering Firepass
5. Print progress: `[12/50] my-app session 2026-05-10 ✓ (8 facts extracted)`

---

## 8. Slash Command — `/memory`

File: `commands/memory.md`

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

## 9. Agent Skill — `skills/memory/SKILL.md`

Tells the agent that it has memory, what the topics mean, and when to use it.
Short, tight:

```markdown
# divmemory

You have a persistent memory system. At the start of this session, your memory 
was loaded into the ## divmemory section of AGENTS.md. Read it before planning work.

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

## 10. Configuration

All config via env vars, read by both hook scripts and the CF Worker:

| Variable | Where set | Purpose |
|---|---|---|
| `DIVMEMORY_API_KEY` | Shell profile / Droid env | Auth token for Worker API |
| `DIVMEMORY_WORKER_URL` | Shell profile (optional) | Override worker URL |
| `FIREWORKS_API_KEY` | CF Worker secret | Firepass auth |
| `DIVMEMORY_DB` | CF Worker binding | D1 database binding |

Plugin hooks read env from the shell environment Droid is running in.
No config file needed — env vars only.

---

## 11. Ship Order

### Phase 1 — Foundation (build this first)
- [ ] D1 schema + migrations
- [ ] CF Worker: `/ingest`, `/context` routes
- [ ] Extraction prompt tuning (test on real Droid sessions)
- [ ] `session-end.mjs` hook script
- [ ] `session-start.mjs` hook script
- [ ] `hooks.json` + `plugin.json`
- [ ] Local test: `droid plugin install ./divmemory` + verify hooks fire

### Phase 2 — Polish
- [ ] Bootstrap CLI (`npx divmemory-bootstrap`)
- [ ] Consolidation pass (cron + manual trigger)
- [ ] `/memory` slash command
- [ ] Agent skill SKILL.md
- [ ] Web UI (vinext, minimal: list + edit + delete)

### Phase 3 — OpenCode
- [ ] Session reader for OpenCode SQLite (`~/.opencode/opencode.db`)
- [ ] Hook equivalent for OpenCode (check if it supports hooks or use wrapper)
- [ ] Same Worker API, new `source: "opencode"` tag

### Phase 4 — Expand
- [ ] Claude Code (JSONL reader + hook)
- [ ] Plugin marketplace listing
- [ ] README + setup docs

---

## 12. Open Questions (decide before building)

1. **Session transcript format**: Droid sends `transcript_path` in the SessionEnd
   hook input — need to verify the exact JSONL schema (fields: role, content,
   tool_use blocks). Inspect a real session file before writing the parser.

2. **AGENTS.md write strategy**: If the user has existing content in AGENTS.md,
   the `## divmemory` section must be idempotent (replace, not append). Need
   to handle the case where `AGENTS.md` doesn't exist yet.

3. **Token budget for injection**: The `/context` route needs a hard token cap,
   not just a line count. 200 lines of short facts ≠ 200 lines of code. Use
   character count proxy: 4 chars ≈ 1 token, cap at ~3000 tokens (12K chars).

4. **Merge strategy for duplicate facts**: When a new session says something
   already in memory, do you update the existing entry or add a new one?
   Proposed: update if confidence of new > old, keep old if same content.

5. **Project identification**: Project is identified by `project_name` (dirname
   of `$FACTORY_PROJECT_DIR`). This breaks if two different projects share a
   directory name. Consider using git remote URL as the canonical project ID
   with dirname as fallback.

6. **Firepass model string**: Verify exact model identifier for Kimi K2.6 Turbo
   on Fireworks Firepass before writing the extraction call.

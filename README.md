# divmemory — Persistent cross-session memory for coding agents

`divmemory` is a Droid plugin + Cloudflare Workers backend that gives your coding agents a persistent second brain. At session end, the full conversation is extracted into structured memory facts and stored in Cloudflare D1. At session start, relevant memory is injected directly into the agent context. Zero file editing, zero git noise.

## Architecture

```
┌─────────────┐     POST /ingest      ┌──────────────────┐
│ Droid Plugin │ ─────────────────────→│  CF Worker (Hono) │
│  hooks + CLI │ ←─── GET /context ────│  + Drizzle ORM    │
└─────────────┘                       └────────┬─────────┘
                                               │
                                        ┌──────▼──────┐
                                        │  Fireworks   │
                                        │  Firepass    │
                                        │  (extraction)│
                                        └──────┬──────┘
                                               │
                                        ┌──────▼──────┐
                                        │ Cloudflare D1│
                                        │  (SQLite)    │
                                        └─────────────┘
```

**Hook flow**: SessionEnd → extract conversation → POST to Worker → Firepass fact extraction → D1 storage. SessionStart → GET context → stdout → injected into agent context.

**Memory topics**: `project_context`, `decisions`, `issues`, `preferences`, `general`.

## Setup

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (for local dev and deploy)
- Cloudflare account with D1 enabled
- Fireworks AI account with Firepass subscription

### Install

```bash
git clone https://github.com/divkix/divmemory.git
cd divmemory
bun install
```

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DIVMEMORY_API_KEY` | Shell / Droid env | Auth token for Worker API |
| `DIVMEMORY_WORKER_URL` | Shell (optional) | Override worker URL |
| `FIREWORKS_API_KEY` | Worker secret | Firepass auth |
| `FIREWORKS_MODEL` | Worker env (optional) | Model string (default: `accounts/fireworks/routers/kimi-k2p6-turbo`) |
| `DIVMEMORY_WEB_PASSWORD` | Worker secret | Password for web UI login |

Set Worker secrets:

```bash
cd worker
npx wrangler secret put FIREWORKS_API_KEY
npx wrangler secret put DIVMEMORY_WEB_PASSWORD
```

### Local development

```bash
# Create local D1 database
cd worker && npx wrangler d1 create divmemory-db

# Apply migrations
npx wrangler d1 execute divmemory-db --local --file=./drizzle/migrations/*.sql

# Start the worker
bun run dev    # runs `wrangler dev --port 8787`
```

### Plugin installation in Droid

1. Add the repo as a marketplace: `https://github.com/divkix/divmemory`
2. Install the `divmemory` plugin from the marketplace
3. Set `DIVMEMORY_API_KEY` in your shell profile or Droid env

## Project structure

```
divmemory/
├── worker/                  # CF Worker (Hono + Drizzle)
│   ├── src/
│   │   ├── index.ts         # Hono router + middleware
│   │   ├── auth.ts          # API key + cookie auth
│   │   ├── login.ts         # Web UI login endpoint
│   │   ├── csrf.ts          # CSRF protection
│   │   ├── schema.ts        # Drizzle D1 schema
│   │   └── routes/
│   │       ├── ingest.ts    # POST /ingest — receive + extract
│   │       ├── context.ts   # GET /context — formatted memory
│   │       ├── consolidate.ts # POST /consolidate
│   │       ├── memories.ts  # GET/PATCH/DELETE /memories
│   │       └── webui.tsx    # Hono JSX web UI
│   ├── wrangler.toml
│   └── vitest.config.ts
├── plugin/                  # Droid plugin
│   ├── plugin.json          # Plugin manifest
│   ├── hooks.json           # Hook configuration
│   ├── scripts/
│   │   ├── session-end.mjs  # SessionEnd hook script
│   │   └── session-start.mjs # SessionStart hook script
│   ├── commands/
│   │   └── memory.md        # /memory slash command
│   └── skills/
│       └── memory/SKILL.md  # Agent skill definition
├── cli/                     # Bootstrap CLI (npm: divmemory-bootstrap)
│   └── src/
│       ├── index.ts         # Entry point
│       └── cli.ts           # CLI logic + batch import
├── specs/
│   └── initial.md           # Full project specification
└── package.json             # Bun workspaces root
```

## Scripts

| Command | Description |
|---|---|
| `bun install` | Install all workspace dependencies |
| `bun run dev` | Start Worker locally (`wrangler dev --port 8787`) |
| `bun test` | Run all tests (Vitest) |
| `bun run typecheck` | Type-check all packages (`tsc --noEmit`) |
| `bun run lint` | Lint all packages (`biome check .`) |
| `bun run format` | Auto-fix lint issues (`biome check --write .`) |
| `bun run build` | Build all packages |

Worker-specific (run from `worker/`):

| Command | Description |
|---|---|
| `bun run deploy` | Deploy Worker (`wrangler deploy`) |
| `bun run dev` | Local dev server on port 8787 |

## Testing

All tests use [Vitest](https://vitest.dev). Run from the repo root:

```bash
bun test            # Run all tests
bun test --watch    # Watch mode
```

**429 tests** covering:

- **Worker routes**: ingest, context, consolidate, memories, web UI — mocked Firepass, in-memory D1
- **Plugin hooks**: SessionEnd conversation extraction, SessionStart context injection
- **CLI**: JSONL parsing, batch logic, error handling
- **Auth**: API key, cookie, CSRF
- **Schema**: Drizzle models, constraints, indexes

## Worker API

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/ingest` | Bearer | Submit session transcript for extraction |
| `GET` | `/context?project=<id>` | Bearer | Get formatted memory block for project |
| `POST` | `/consolidate` | Bearer | Trigger consolidation pass |
| `GET` | `/memories?project=<id>` | Bearer/Cookie | List memories (JSON) |
| `PATCH` | `/memories/:id` | Bearer/Cookie | Edit a memory entry |
| `DELETE` | `/memories/:id` | Bearer/Cookie | Delete/archive a memory |
| `GET` | `/` | Cookie | Web UI (Hono JSX) |
| `POST` | `/login` | — | Web UI login (sets cookie) |

## Deployment

```bash
cd worker

# Create D1 database (first time)
npx wrangler d1 create divmemory-db

# Apply migrations
npx wrangler d1 execute divmemory-db --remote --file=./drizzle/migrations/*.sql

# Set secrets
npx wrangler secret put FIREWORKS_API_KEY
npx wrangler secret put DIVMEMORY_WEB_PASSWORD

# Deploy
bun run deploy
```

The Worker runs a daily cron at 3am UTC for automatic memory consolidation.

## Bootstrap CLI

Import past sessions in bulk:

```bash
npx divmemory-bootstrap [--dir ~/.factory] [--limit 50] [--dry-run]
```

Finds session JSONL files, extracts conversations, and POSTs them to the Worker for processing.

## Tech stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com)
- **Framework**: [Hono](https://hono.dev) (router, JSX, middleware)
- **ORM**: [Drizzle](https://orm.drizzle.team) (D1 SQLite)
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1)
- **Extraction**: [Fireworks Firepass](https://fireworks.ai) (Kimi K2.6 Turbo)
- **Validation**: [Zod](https://zod.dev)
- **Runtime**: [Bun](https://bun.sh) (package management, test runner)
- **Testing**: [Vitest](https://vitest.dev)
- **Lint/Format**: [Biome](https://biomejs.dev)
- **Language**: TypeScript (strict mode)

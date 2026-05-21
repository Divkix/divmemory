# Repository Guidelines

## Project Structure

This is a monorepo using Bun workspaces with three packages:

- `worker/` - Cloudflare Worker (Hono + Drizzle ORM + SQLite/D1)
- `cli/` - Bootstrap CLI tool (`divmemory-bootstrap`)
- `plugin/` - Plugin package

Source lives in each workspace's `src/` directory. Tests are co-located as `*.test.ts` files.

## Build, Test, and Development Commands

Run these from the repository root:

| Command | Description |
|---------|-------------|
| `bun install` | Install dependencies across all workspaces |
| `bun run dev` | Start the worker dev server (port 8787) |
| `bun run typecheck` | TypeScript type checking across all workspaces |
| `bun run build` | Build all packages |
| `bun run test` | Run all tests via Vitest |
| `bun run lint` | Check formatting and linting with Biome |
| `bun run format` | Auto-fix Biome issues |

## Coding Style

- **Formatter**: Biome — tab indentation, double quotes, semicolons, trailing commas
- **TypeScript**: Strict mode enabled; use `import type` for type-only imports
- **No `any`**: The linter enforces explicit typing
- **Line width**: 100 characters

## Testing

- **Framework**: Vitest
- **Pattern**: Tests are co-located alongside source files (`*.test.ts`)
- **Run specific workspace**: `cd worker && bun run test`
- CI runs the full test suite on every push and pull request.

## Commit & Pull Request Guidelines

This project uses **Conventional Commits** with scope prefixes:

```
<scope>: <description>
```

Examples from history:
- `refactor(worker): extract shared utilities and split webui (#4)`
- `fix(worker): anchor turn boundary search to newline prefix`
- `chore(deps): bump all dependencies to latest versions`
- `test: complete 78 deferred assertions for issue #1`

PRs should include a clear description, and CI must pass (lint, typecheck, build, test).

## Architecture Overview

- **Runtime**: Cloudflare Worker
- **Web Framework**: Hono with JSX rendering
- **Database**: SQLite via Drizzle ORM (managed via Wrangler/D1)
- **Validation**: Zod
- **Deployment**: Wrangler CLI (`wrangler deploy` from `worker/`)
- **CI/CD**: GitHub Actions workflow runs `install`, `lint`, `typecheck`, `build`, `test`

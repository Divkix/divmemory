Full docs: https://divmemory-docs.divkix.workers.dev

# Repository Guidelines

## Project Structure

This is a Bun monorepo with four workspaces:

```text
worker/   — Cloudflare Worker (Hono + D1 + Drizzle), web UI, and REST API
plugin/   — Factory Droid plugin (scripts, commands, skills)
cli/      — Bootstrap CLI for project setup
docs/     — Starlight documentation site (deployed separately)
e2e/      — Playwright end-to-end tests
specs/    — Feature specifications
```

Worker database access uses the typed seam in `worker/src/db/` (`Database`, `D1DrizzleAdapter`, `BunSQLiteAdapter`, `InMemoryAdapter`).

Source code lives in `src/` within each workspace. Tests are co-located (`*.test.ts`) or in a `tests/` directory.

## Build, Test, and Development Commands

| Command | Purpose |
|---------|---------|
| `bun dev` | Start the worker dev server (port 8787) |
| `bun run lint` | Run Biome checks across all workspaces |
| `bun run format` | Auto-format with Biome |
| `bun run typecheck` | TypeScript type-check all workspaces |
| `bun run build` | Build all workspaces |
| `bun test` | Run all Vitest unit tests |
| `bun run test:e2e` | Run Playwright E2E tests (requires a running dev server) |

Per-workspace commands use `--filter`:
```
bun run --filter @divmemory/worker test:cf    # Cloudflare integration tests
bun run --filter @divmemory/worker deploy     # Deploy to Cloudflare
```

## Coding Style & Naming

- **Formatting**: Biome — tabs (width 2), double quotes, semicolons, trailing commas, LF line endings, 100-char width
- **TypeScript**: Strict mode, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`
- **Lint rules**: `noUnusedImports`, `noUnusedVariables`, `noExplicitAny`, `useImportType` (all errors)
- **Imports**: Use `import type` for type-only imports
- **Validation**: Zod schemas for runtime validation
- **Framework**: Hono for HTTP, Drizzle ORM for database access

## Testing Guidelines

- **Unit tests**: Vitest (`vitest.config.ts` in each workspace). Co-locate test files as `*.test.ts`.
- **Cloudflare integration tests**: `vitest.cloudflare.config.ts` — uses `@cloudflare/vitest-pool-workers`
- **E2E tests**: Playwright (`e2e/` directory) with desktop and mobile projects. Run `bun run test:e2e`.
- CI runs tests on Ubuntu and Windows. E2E runs on Ubuntu only.

## Commit & Pull Request Guidelines

- **Commits**: [Conventional Commits](https://www.conventionalcommits.org/) with optional scope — `feat(worker):`, `fix(plugin):`, `refactor:`, `test:`, `docs:`, `chore:`
- **PRs**: Reference issues in the body (e.g., `closes #16`). CI must pass (lint, typecheck, build, test, Cloudflare integration tests, E2E) before merging.
- Target `main` as the base branch.

## Environment & Secrets

Copy `.dev.vars.example` to `.dev.vars` and fill in secrets. Never commit `.dev.vars` or `.env` files. Use `wrangler secret` for production secrets.

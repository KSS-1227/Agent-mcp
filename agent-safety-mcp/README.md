# Agent Safety MCP

Agent Safety MCP provides MCP tools for coordinating agent actions against shared resources. It combines two integrated subsystems:

- **Conflict Engine** (`src/conflict-engine/`) records agent intents, detects conflicts, and supports conflict resolution and resource-access checks. This subsystem originated in Interlock.
- **Recovery Engine** (`src/recovery-engine/`) coordinates safe action execution, enforces idempotency, and supports crash recovery and reconciliation. This subsystem originated in Anchor.

Both subsystems use the shared core and PostgreSQL/Supabase database abstraction. MCP tool registration and server startup are in `src/mcp/` and `src/start-server.ts`.

## Development

Install dependencies with `npm install`. Use `npm run typecheck` to type-check the TypeScript source and `npm run build` to compile the project and bundle the production server. `npm start` runs the production bundle.

Runtime configuration is validated by `src/config/`; consult that module and the deployment-specific environment configuration when setting up a server. Do not commit credentials or local environment files.

## Project layout

- `src/conflict-engine/` — intent and conflict detection services.
- `src/recovery-engine/` — action coordination, idempotency, verification, and reconciliation.
- `src/core/` — shared agents, resources, tasks, and types.
- `src/database/` — shared PostgreSQL database client.
- `src/mcp/` — MCP server and tool adapters.
- `supabase/` — database migrations.
- `tests/` — unit and integration tests, including separately guarded live integration tests.

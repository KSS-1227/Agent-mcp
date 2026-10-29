# Agent Safety MCP — Web Dashboard

A production-grade, responsive control plane and observability dashboard for **Agent Safety MCP**, demonstrating multi-agent coordination, deterministic conflict prevention, exactly-once action execution, and crash-safe reconciliation.

## Key Features

- **Overview (`/`)**: Real-time operational metrics (agent count, active actions, detected conflicts, pending recoveries, commit outcome ratios, and chronological activity feed).
- **Agents (`/agents`)**: Searchable and filterable table of verified agents with metadata, roles, permissions, declared plans, and execution history.
- **Intents & Resources (`/intents`)**: Declared plans, snapshot HLC timestamps, version observation comparisons (`observed_version` vs `current_version`), and step-level status tracking (`pending`, `done`, `invalidated`, `repaired`).
- **Conflict Monitor (`/conflicts`)**: Interactive SVG/Canvas provenance graph (Agents → Intents → Conflicts → Resources) with zoom, pan, node selection, filter toggles, and step-level adjudication ruling breakdowns (Grok/NVIDIA Nemotron).
- **Action Lifecycle (`/actions`)**: Tracking of three-phase execution (`prepare_action` → `execute_action` → `complete_action`), sha256 idempotency key derivation, lease expiration, and effect states (`NOT_STARTED`, `IN_PROGRESS`, `APPLIED`, `NOT_APPLIED`, `UNKNOWN`).
- **Recovery Center (`/recovery`)**: Dedicated surface for crash recovery, showing orphaned actions with expired leases, verifier proof inspection, and explicit manual reconciliation confirmation.
- **Evidence & Audit (`/evidence`)**: Immutable audit log of verification receipts (correlation markers, external URLs, commit txids) and committed episode narratives with 1024-dimensional vector status.
- **Settings & Health (`/settings`)**: Safe infrastructure metadata, database latency, MCP health daemon status, and capability verification with **zero secret leakage**.

---

## Design System & Theme

Built with a calm, eye-friendly, enterprise developer-tool aesthetic:

| Token | Color Code | Usage |
|---|---|---|
| Background | `#F6F5F1` | Warm off-white workspace canvas |
| Sidebar | `#242622` | Deep charcoal navigation bar |
| Surfaces | `#FFFFFF` | Clean primary cards and tables |
| Borders | `#E5E4DE` | Thin, soft neutral dividers |
| Primary Text | `#252722` | Dark charcoal high-contrast typography |
| Secondary Text | `#777A73` | Muted slate secondary labels and timestamps |
| Primary Accent | `#52745B` | Muted forest green for primary actions & safe states |
| Secondary Accent | `#8A916A` | Restrained olive for system roles and version tags |
| Status Amber | `#B58533` | Restrained amber for pending, busy, or threatened states |
| Status Red | `#A8423F` | Muted brick red for conflicts, invalidations, and failures |

---

## Live Mode vs Demo Mode

- **Live Mode**: Directly queries the local PostgreSQL/Supabase database and the MCP Health daemon (`http://127.0.0.1:8081`). If the backend is unreachable or offline, the interface displays an explicit diagnostic banner with honest empty/error states—never fabricating fake data.
- **Demo Mode**: Surfaces rich, deterministic domain fixtures modeled directly on the Agent Safety architecture for presentations and offline testing. Displays a persistent `DEMO MODE` badge and never writes records to the database.

---

## Getting Started

### 1. Install Dependencies

```bash
cd web
npm install
```

### 2. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Production Build & Start

```bash
npm run build
npm start
```

### 4. Running With the Backend

To connect to live backend services:
1. Ensure the PostgreSQL database and MCP health server are running in `agent-safety-mcp`:
   ```bash
   cd agent-safety-mcp
   npm run build
   npm start
   ```
2. In `web/`, ensure `.env` or system environment has `DATABASE_URL` and `HEALTH_PORT=8081`.
3. Switch the top bar mode toggle to **Live Mode**.


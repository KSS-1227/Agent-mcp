# Create ANTIGRAVITY.md — Master Frontend Development Instructions

Act as a senior frontend engineer, product designer, design systems architect, and full-stack integration engineer.

Create a comprehensive `ANTIGRAVITY.md` file in the current `MCP SERVER` workspace root by combining the complete frontend implementation requirements and the strict visual design requirements below.

This task is to create the instruction file first. Do not start implementing the frontend until the file has been created and its contents verified.

The file must be a persistent, unambiguous source of truth for subsequent frontend development.

---

# 1. Project identity and architecture

The product is **Agent Safety MCP**, an agent-coordination and safety system that prevents conflicting operations, coordinates action execution, and supports crash-safe recovery.

The workspace currently contains three separate project directories:

- `agent-safety-mcp/` — unified MCP backend.
- `conflict-engine/` — original Interlock source repository.
- `recovery-engine/` — original Anchor source repository.

The unified backend already contains:

- `src/conflict-engine/` — conflict detection, intents, provenance, and resource coordination.
- `src/recovery-engine/` — action coordination, idempotency, verification, and recovery reconciliation.
- `src/core/` — shared domain logic.
- `src/database/` — PostgreSQL database access.
- `src/mcp/` — MCP server and tools.

The intended infrastructure includes:

- Supabase PostgreSQL for persistence.
- AWS Bedrock/Grok provider integration for supported LLM operations.

The frontend must be based on the actual current implementation. Inspect the repository before assuming which APIs, data models, or operations exist.

Do not confuse the original sibling repositories with the active unified backend. Do not merge, overwrite, or restructure them unnecessarily.

# 2. Frontend objective

Build a polished, responsive operational dashboard for engineers who need to understand and monitor:

- AI agent coordination.
- Intent declarations and resource ownership.
- Conflict detection and prevention.
- Safe action execution.
- Idempotency and action lifecycle.
- Crash recovery and reconciliation.
- Verification evidence and audit history.
- Backend and provider health.

This is an engineering and reliability product, not a marketing website and not a generic AI chatbot interface.

The finished application should be suitable for a technical hackathon demonstration and should remain understandable and useful beyond the demo.

# 3. Mandatory visual identity

## Design direction

Use the visual language of a premium enterprise infrastructure, observability, and developer-tool product.

The interface must feel calm, precise, trustworthy, professional, and easy on the eyes during long working sessions.

It must NOT look like a typical AI-generated SaaS dashboard.

## Approved color palette

Use these colors as the initial design tokens:

- Main workspace background: warm off-white `#F6F5F1`
- Sidebar background: deep charcoal `#242622`
- Primary surface: white `#FFFFFF`
- Primary text: dark charcoal `#252722`
- Secondary text: muted gray `#777A73`
- Borders and dividers: soft neutral gray `#E5E4DE`
- Primary accent: muted forest green `#52745B`
- Secondary accent: restrained olive `#8A916A`

Use semantic status colors only where they communicate real system states:

- Success: muted green.
- Warning or pending: restrained amber.
- Failure or conflict: muted red.
- Inactive, unknown, or unavailable: neutral gray.

Validate text contrast and accessibility rather than blindly using a palette value when it fails contrast requirements.

A consistent dark theme may be added later, but the default should use the warm-neutral workspace and charcoal sidebar.

## Strict visual prohibitions

Do not use:

- Purple or violet as a primary accent.
- Electric blue or cyan as a visual theme.
- Blue-purple gradients.
- Neon glow or glowing borders.
- Futuristic sci-fi styling.
- Excessive glassmorphism or translucent floating cards.
- Gradients behind every metric.
- Oversized headings and excessive empty space.
- Giant rounded cards across the whole interface.
- Decorative charts with no operational meaning.
- Robot illustrations, generic AI graphics, or decorative generated artwork.
- Excessive animations or visual effects.

Do not introduce purple or blue styling simply because a UI library uses it by default. Override the relevant design tokens and component styles consistently.

# 4. Layout and component design system

Establish the design system before implementing all dashboard pages.

Define reusable tokens and standards for:

- Colors and semantic status colors.
- Typography and font sizes.
- Spacing and grid layout.
- Borders and corner radii.
- Shadows.
- Buttons and form controls.
- Sidebar and top navigation.
- Tables and pagination.
- Status indicators.
- Charts and graph nodes.
- Loading skeletons.
- Empty, error, unavailable, and disconnected states.

Use a precise grid, clear hierarchy, compact controls, subtle separators, and restrained shadows.

Use corner radii generally between 6 and 10 pixels, avoiding excessive rounding.

Use a professional sans-serif font. Keep body text readable, labels concise, and data tables compact but not cramped.

The design must feel intentionally art-directed by an experienced product designer rather than assembled from a generic dashboard template.

# 5. Application navigation

Create a consistent dashboard shell with a compact charcoal sidebar and a clean top bar.

Sidebar pages:

1. Overview
2. Agents
3. Intents & Resources
4. Conflict Monitor
5. Action Lifecycle
6. Recovery Center
7. Evidence & Audit
8. Settings

Requirements:

- Consistent monochrome icons.
- Clear active navigation state.
- Responsive mobile navigation.
- Accessible focus indicators.
- Tooltips only when useful.
- Breadcrumbs or page titles where appropriate.
- No decorative elements that compete with operational data.

The top bar may include product identity, refresh controls, environment information, and backend status.

Only show information that is actually available. Do not display fake connection indicators or a fabricated user identity.

# 6. Dashboard pages

## Overview

Display real, available metrics such as registered agents, active actions, detected conflicts, recovery operations, and action outcomes.

Include recent activity and component health where supported by the backend.

Every metric must have a defined source. If data is unavailable, show an honest unavailable or empty state.

## Agents

Provide a searchable and filterable agent list, with detail views for known intents, resources, actions, and audit history where supported.

Do not invent agent management operations.

## Intents & Resources

Display intent declarations, resource identifiers, versions, provenance, and related agents when available.

Represent only relationships and version history supported by the backend.

## Conflict Monitor

Provide a conflict table and detail view containing supported information such as involved agents, affected resources, version information, detection reasons, and evidence.

An interactive graph may show agents, intents, and resources only when real relationship data is available.

Do not imply semantic vector detection is active unless the existing runtime actually invokes it.

## Action Lifecycle

Display actual action identifiers, action types, supported states, resource versions, idempotency details, verification results, and timestamps when available.

Map backend states accurately. Do not invent lifecycle states or timestamps.

## Recovery Center

Display reconciliation status, pending recovery, attempts, verification evidence, and failure reasons where available.

Opening this page must never trigger a recovery operation.

Any supported manual operation must use the existing protected backend workflow, including authorization, identity, and idempotency checks.

If no safe manual operation exists, keep the interface read-only.

## Evidence & Audit

Provide searchable event history, provenance, verification evidence, timestamps, and linked action or resource identifiers where available.

Do not fabricate evidence or expose secrets.

## Settings

Display safe system configuration metadata and genuine health information.

Never expose database credentials, service-role keys, AWS credentials, LLM keys, or secret environment values.

Do not add a UI for editing server secrets.

# 7. Frontend technology and integration

Inspect the existing project before choosing a framework.

Preferred stack, if compatible:

- Next.js.
- React.
- TypeScript.
- Tailwind CSS.
- shadcn/ui.
- Lucide icons.
- Recharts for useful charts.
- React Flow or an equivalent for a genuine interactive graph.

Reuse a suitable existing framework if one is already present.

If the unified backend is backend-only, keep the frontend in a separate `web/` directory unless inspection identifies a better established structure.

Keep the frontend separate from the MCP server's execution logic.

The MCP server is not automatically a browser-accessible REST API. Inspect the existing transport, tools, authentication, authorization, and database access patterns before integrating.

Reuse existing interfaces when safe. If a web API adapter is necessary, document its scope and keep it thin.

Do not duplicate business logic, create a parallel database schema, or bypass the MCP server's safety checks.

Never expose secrets to the browser. Validate inputs server-side and authorize every protected operation.

If an endpoint does not exist, document the limitation rather than faking a successful response.

# 8. Live data and demo mode

Support clearly separated live and demo states.

Live mode must use real backend data and actual health checks.

Demo mode may use sample data for presentations, but it must display a persistent, visible DEMO label.

Never silently substitute mock data when a live request fails.

Never write demo data to Supabase.

Do not fabricate operational metrics, successful recovery events, conflict history, provider availability, or evidence.

Provide honest loading, empty, disconnected, and error states.

# 9. Data visualization

Visualizations must communicate operational meaning.

Use restrained colors, readable labels, clear legends, meaningful units, and subtle gridlines.

Use neutral graph nodes and thin connections. Highlight selected entities or actual conflicts with semantic colors.

Avoid excessive chart colors, meaningless trends, and decorative statistics.

Charts should only be implemented when useful real data exists.

# 10. Responsive behavior and accessibility

Desktop:

- Persistent or collapsible sidebar.
- Multi-column metric layout.
- Dense but readable tables.
- Useful detail panels and graph space.

Tablet:

- Collapsible sidebar.
- Reduced grid columns.
- Responsive data tables.

Mobile:

- Drawer navigation.
- Single-column metrics.
- Readable timelines.
- Touch-friendly controls.
- Responsive tables or card layouts where appropriate.
- Avoid unnecessary horizontal scrolling.

Provide keyboard navigation, visible focus states, semantic markup, sufficient contrast, and reduced-motion support.

# 11. Implementation quality

Require:

- Reusable and typed components.
- Clearly separated API integration logic.
- Explicit handling of loading, empty, error, and stale-data states.
- No unnecessary dependencies.
- No broken imports or missing assets.
- No fake interactions or nonfunctional buttons.
- No hardcoded secrets.
- No unverified claims about backend behavior.
- No modifications to MCP tool names, database migrations, provider behavior, or recovery safety logic just to simplify the frontend.

Keep the design consistent across every page.

# 12. Mandatory design review

Before declaring the frontend complete:

1. Inspect all pages at desktop, tablet, and mobile sizes.
2. Verify that the warm-neutral and charcoal design system is consistently applied.
3. Remove unintended purple, violet, cyan, and blue accents.
4. Eliminate generic AI-dashboard styling, unnecessary gradients, and decorative elements.
5. Review typography, spacing, alignment, table readability, and semantic status colors.
6. Check loading, empty, error, disconnected, live, and demo states.
7. Verify accessibility and reduced-motion behavior.
8. Ensure every visible control has a meaningful action or is clearly disabled with an explanation.

The final interface must feel like a cohesive enterprise reliability product, not a generic AI-generated template.

# 13. Verification and delivery

After implementation, run the existing typecheck, production build, and relevant non-live tests.

Verify frontend routes, responsive behavior, and integration errors.

Do not run database migrations, destructive operations, or live external-service tests without explicit authorization.

Do not initialize Git, commit, push, or deploy unless separately requested.

Report:

- Files created and modified.
- How to run the frontend and backend.
- Which pages use real data.
- Which features are read-only or unavailable.
- Any endpoints still required.
- Actual build and test results.
- Remaining blockers or limitations.

# 14. Development workflow

Follow this order:

1. Inspect the workspace and existing architecture.
2. Create and verify this `ANTIGRAVITY.md` instruction file.
3. Identify the compatible frontend structure.
4. Establish the visual design tokens and shared components.
5. Implement the dashboard shell.
6. Implement pages incrementally.
7. Integrate only verified backend interfaces.
8. Perform the mandatory visual and functional review.
9. Run permitted verification and document results.

Do not skip the architecture inspection or visual review.

## Final design objective

Deliver a premium, calm, precise, trustworthy Agent Safety MCP dashboard with warm-neutral surfaces, charcoal navigation, muted forest-green accents, readable operational data, and carefully designed safety-oriented interactions.

The interface should look intentionally designed by a senior product designer, feel pleasant during long engineering sessions, and communicate the real technical value of agent conflict prevention and crash-safe recovery.

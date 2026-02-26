# Spec 7 - Frontend Stack Decision (Vue vs Solid)

## Objective

Make an explicit frontend technology decision before building the benchmark client UI.

## Context

- Preference is Vue if possible.
- OpenCode currently uses Solid-based frontend packages.
- Project goal is architectural compatibility with an OpenCode-like server/client split.
- No visuals or mockups were provided during shaping.

## Deliverables

- Decision record with chosen stack and rationale.
- Evaluation matrix (developer velocity, ecosystem fit, SSR/build tooling, SDK ergonomics from OpenAPI `/doc`, SSE support, long-term maintainability).
- Risk/mitigation notes for the non-chosen option.
- Minimal client integration spike plan for the chosen stack.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Full client implementation.
- Visual design system definition.

## Decision tasks

1. Define evaluation criteria and scoring weights.
   - Define criteria (minimum):
     - developer velocity (DX, tooling maturity)
     - ecosystem fit (router, state, component libs)
     - build/SSR options and deployment simplicity
     - OpenAPI SDK ergonomics (types, runtime client)
     - SSE support and reconnection handling
     - auth + CORS handling (basic auth, preflight)
     - maintainability (team familiarity, community trajectory)
   - Assign weights and document why.
   - Manual testing steps:
     - Review the criteria doc with at least one other contributor and confirm agreement on weights.

2. Evaluate Vue and Solid against server API integration needs.
   - Build a minimal spike for each option:
     - generate/consume the server SDK (from `/doc`)
     - call `GET /global/health`
     - connect to SSE `GET /event` and render incoming events
     - handle basic auth and CORS preflight
   - Record friction points:
     - bundler config
     - type generation/runtime client ergonomics
     - SSE reconnection strategy
     - deployment artifacts
   - Manual testing steps:
     - Run the server with auth and CORS:
       - `export CHIMERA_SERVER_PASSWORD=devpass`
       - `chimera-bench serve --cors http://localhost:5173`
     - Run each spike app and verify it:
       - renders health output
       - shows `server.connected` and heartbeat events from SSE
       - fails gracefully on wrong password

3. Record final decision and migration fallback plan.
   - Write a short decision record:
     - chosen stack
     - top reasons (tied back to weighted criteria)
     - key risks and mitigations
     - fallback plan (what would trigger a switch)
   - Manual testing steps:
     - Re-run the chosen spike and confirm it covers all required integration surfaces.

4. Update product docs/roadmap with final frontend stack.
   - Update `agent-os/product/` docs and any impacted spec references.
   - Manual testing steps:
     - `rg -n "Vue|Solid" agent-os/product/ agent-os/specs/` and confirm references match the final decision.

## Exit criteria

- Frontend stack decision is documented and approved, unblocking client implementation.

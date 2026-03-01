# Frontend Stack Decision (Vue vs Solid) - Shaping Notes

## Scope

- Choose a frontend stack for the benchmark client UI.
- Validate the choice against the server's integration needs:
  - OpenAPI-generated SDK ergonomics
  - SSE consumption (`/event`, `/runs/:runId/event`)
  - basic auth + CORS behavior
  - long-term maintainability

## Decisions

- Prefer Vue if it satisfies the integration needs with acceptable risk.
- Treat OpenCode's Solid/Vite baseline as a strong reference point.
- Require a minimal integration spike for both candidates before the final decision.
- Visuals: none.

## Assumptions

- The server exposes OpenAPI 3.1 at `/doc` and SSE endpoints per `server/api-conventions`.

## Success Criteria

- A documented decision with evidence from a small spike, plus a clear fallback plan.

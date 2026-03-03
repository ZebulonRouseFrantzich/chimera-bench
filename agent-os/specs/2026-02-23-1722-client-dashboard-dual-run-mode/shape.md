# Client Dashboard and Dual Run Mode - Shaping Notes

## Scope

- Build a web client that can configure runs, monitor progress, and view results.
- Support connecting to:
  - a local server (same machine)
  - a remote server (LAN/SSH scenarios)
- Provide a "dual run mode": run server and client together for local dev, or separately for remote usage.

## Decisions

- Frontend stack is chosen in `frontend-stack-decision-vue-vs-solid`; this spec implements the client using that stack.
- Treat the server OpenAPI `/doc` and SSE endpoints as first-class integration surfaces.
- Keep client initially single-user/power-user focused.
- Visuals: none.

## Assumptions

- Server provides stable APIs: `/global/health`, `/engines`, `/workloads`, `/runs`, `/event` and per-run SSE.

## Risks

- SSE reconnection and long-running run UX can be tricky; bake in resilience early.

## Success Criteria

- A user can complete the end-to-end workflow using only the client UI.

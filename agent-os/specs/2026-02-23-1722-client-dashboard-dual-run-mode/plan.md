# Spec 8 - Client Dashboard and Dual Run Mode

## Objective

Build the benchmark client UI and enable running server and client together or separately.

## Context carried from shaping

- The client should preserve the OpenCode-style flexibility: run both processes together or split across machines.
- UI work starts only after frontend stack selection is explicit.
- Initial product scope remains single-user/power-user, with room to evolve.

## Deliverables

- Web client for configuring runs, monitoring progress, and viewing/exporting results.
- Live updates via SSE/WebSocket.
- Dev and packaged commands to run:
  - server only
  - client only
  - both together
- Clear connection model for local or remote server targets.
- Connect-to-server UX that supports explicit `hostname` + `port` and optional mDNS-discovered endpoints.
- API docs integration path based on server OpenAPI `/doc` output.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- See `references.md`.

## Non-goals

- Complex multi-user account systems.
- Mobile-native client applications.

## Implementation tasks

1. Implement client shell and navigation.
   - Use the chosen frontend stack from Spec 7.
   - Pages (initial):
     - Connect (server selection + auth)
     - Engines (capabilities + environment validation summary)
     - Workloads (list/select)
     - Runs (create + history)
     - Run detail (progress + results)
   - Manual testing steps:
     - Start client dev server and verify navigation renders on desktop + mobile widths.

2. Build server connection setup and validation flow.
   - Connection inputs:
     - `hostname`, `port`
     - username (default `chimera`) and password
     - optional mDNS-discovered endpoints (when available)
   - Validation:
     - call `GET /global/health` and show server version/healthy state
     - handle `401` with actionable prompts
   - Persistence:
     - store last-used connection info in browser storage (do not store plaintext password unless explicitly enabled)
   - Manual testing steps:
     - Start server with auth + CORS: `CHIMERA_SERVER_PASSWORD=devpass chimera-bench serve --cors http://localhost:5173`
     - In the client, connect to `127.0.0.1:4096` with correct creds and verify health shows as connected.
     - Enter a wrong password and verify the UI shows an auth error.

3. Build forms for workload and sweep setup.
   - Form fields map directly to server APIs:
     - engine selection (`engineId`)
     - target selection (`local` vs `ssh` + target profile)
     - model identifier (local path or remote path depending on target)
     - workload selection (`workloadId`)
     - optional sweep axes (when sweeps are available)
     - validation mode (strict/permissive)
   - Validate inputs client-side with the same constraints as the server (at minimum, required fields and obvious type errors).
   - Manual testing steps:
     - Open the run creation form and verify it can create a single local run end-to-end.
     - If sweeps are enabled, create a small 2x2 sweep and verify the UI renders the expanded case count.

4. Implement live run monitor and result visualizations.
   - Subscribe to SSE:
     - global `GET /event`
     - per-run `GET /runs/:runId/event`
   - UI behaviors:
     - show progress (completed/total)
     - show per-case status table
     - show summary stats from `result.json`/exports
     - support cancel button (`POST /runs/:runId/cancel`)
   - Manual testing steps:
     - Create a run and verify SSE events update the UI without refresh.
     - Cancel a run mid-flight and confirm the UI transitions to `cancelled`.

5. Add dual-run scripts and documentation.
   - Provide developer scripts to run:
     - server only
     - client only
     - both together
   - Ensure CORS defaults work for local dev.
   - Manual testing steps:
     - Run `server only` and verify the client can connect to it.
     - Run `both together` and verify the client loads and can start a run.

6. Add client integration tests against the server API.
   - Add automated tests (e.g., Playwright) for:
     - connect flow (401 + success)
     - run creation
     - SSE progress rendering
     - cancellation
   - Manual testing steps:
     - Run tests: `bun test` (and/or `bun run test:e2e`)

## Exit criteria

- Users can run the full benchmark workflow through the client and choose combined or split deployment modes.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, `sweep-engine-run-orchestration`, `log-metrics-efficiency-analysis`, `server-auth-and-ssh-secret-hardening`, `ssh-remote-execution-profiles`, and `frontend-stack-decision-vue-vs-solid`.

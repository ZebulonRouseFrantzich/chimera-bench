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

- OpenCode architecture reference: `https://github.com/anomalyco/opencode`
- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode server route patterns: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts`

## Non-goals

- Complex multi-user account systems.
- Mobile-native client applications.

## Implementation tasks

1. Implement client shell and navigation for runs/engines/results.
2. Build server connection setup and validation flow (host/port/auth hints, optional mDNS selection).
3. Build forms for workload and sweep setup.
4. Implement live run monitor and result visualizations from SSE/event streams.
5. Add dual-run scripts and documentation.
6. Add client integration tests against the server API.

## Exit criteria

- Users can run the full benchmark workflow through the client and choose combined or split deployment modes.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, `sweep-engine-run-orchestration`, `log-metrics-efficiency-analysis`, `server-auth-and-ssh-secret-hardening`, `ssh-remote-execution-profiles`, and `frontend-stack-decision-vue-vs-solid`.

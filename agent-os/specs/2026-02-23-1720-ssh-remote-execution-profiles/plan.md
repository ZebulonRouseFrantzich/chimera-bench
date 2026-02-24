# Spec 6 - SSH Remote Execution Profiles

## Objective

Run benchmarks on remote machines over SSH while storing run definitions and artifacts on the orchestrator host.

## Context carried from shaping

- Remote execution must support both local-network and internet-reachable hosts.
- Run details and benchmark artifacts are anchored on the orchestrator side.
- Remote support should preserve the same plugin contract and result schema used for local runs.
- Existing server instances should be connectable via explicit host/port rather than assuming local in-process execution.

## Deliverables

- SSH host profile model (auth method, host, port, remote paths, runtime requirements).
- Remote execution adapter for launching and monitoring engine commands.
- Artifact collection and normalization back to local run storage.
- Remote environment validation checks.
- Failure and retry policy for network interruption scenarios.
- Server connection profile support for client/orchestrator integration (`hostname`, `port`, optional mDNS discovery metadata).

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/plugins/engine-interface.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode split server/client deployment model: `https://github.com/anomalyco/opencode`
- OpenCode server behavior reference: `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/server.ts`

## Non-goals

- Fleet scheduling across many remote hosts.
- Cloud provider provisioning automation.

## Implementation tasks

1. Define remote target schema and profile persistence.
2. Define server connection profile fields (including host/port and optional mDNS domain).
3. Implement SSH command execution and streaming logs.
4. Implement remote-to-local artifact synchronization.
5. Integrate remote mode into run APIs and result metadata.
6. Add integration tests against a controlled SSH target.

## Exit criteria

- A benchmark run can execute remotely and appear locally with complete artifacts and status.

## Dependencies

- Requires `server-plugin-llama-cpp-foundation`, `workload-packs-and-exports`, `sweep-engine-run-orchestration`, and `log-metrics-efficiency-analysis`.
- Should be implemented with or after `server-auth-and-ssh-secret-hardening`.

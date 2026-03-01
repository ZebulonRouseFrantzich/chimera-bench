# App Test Fixtures

Use shared helpers in `tests/helpers/app-fixture.ts` for server route tests.

Rules:

- Build apps via `buildApp()` (returns `{ app, runtime }`).
- Reuse `TEST_MODEL_IDENTIFIER` (a real `.gguf` fixture file) for run creation.
- Persist test run artifacts under a temp root (`tmpdir()/chimera-bench-test-runs-<pid>`), not in the repo.
- Cleanup test artifact dirs on process exit (best-effort, no manual cleanup).

Helpers:

- Use `createRun(app)` for a minimal accepted run request.
- Use `createBasicAuthorization()` for Basic auth headers.

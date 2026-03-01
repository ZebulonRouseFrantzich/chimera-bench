# llama.cpp Strict Flag Validation

`engine.serverArgs` is pass-through, but must be validated.

Always reject:

- Reserved flags owned by the orchestrator:
  - `-m`, `--model`, `--host`, `--port`, `--api-key`, `--api_key`, `--webui`, `--no-webui`
- Denylisted flags blocked by safety policy:
  - `--path-prompt-cache`, `--prompt-cache`, `--prompt-cache-all`, `--logdir`, `--public`
- Positional args (must be `-x`/`--flag` style entries).

`validationMode` behavior:

- `permissive`: allow unknown flags (except reserved/denylisted).
- `strict`:
  - discover supported flags by parsing `llama-server --help` (bounded timeout + bounded output)
  - reject any flag not present in the discovered set
  - cache the discovered set in-process
  - if flag discovery fails, strict validation fails and instructs using `permissive`

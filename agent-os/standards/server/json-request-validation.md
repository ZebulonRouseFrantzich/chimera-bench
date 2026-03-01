# JSON Request Validation

For any endpoint that accepts a JSON body:

- Use `parseJsonBody(context, schema, maxBytes)` from `src/server/http/request-validation.ts`.
- Require `Content-Type` starting with `application/json`.
- Enforce a per-endpoint byte limit while reading the stream.
- Validate with zod; return the standard envelope errors.

Handler pattern:

```ts
const parsed = await parseJsonBody(context, SomeSchema, 64 * 1024);
if (parsed instanceof Response) return parsed;
// parsed is typed schema output
```

Status/code mapping:

- `415` `VALIDATION_CONTENT_TYPE_INVALID`
- `413` `VALIDATION_BODY_TOO_LARGE`
- `400` `VALIDATION_JSON_INVALID` (missing/empty/invalid JSON)
- `400` `VALIDATION_BODY_INVALID` (JSON parsed but schema mismatch)

Validation issue details:

- Put issues at `error.details.issues`.
- Each issue: `{ code, message, path }`.
- `path` uses dotted + `[index]` notation; use `(root)` when empty.

Path params:

- Validate path params with zod (example: `parseRunIdParam`).
- On failure return `400` `VALIDATION_PARAMS_INVALID` with `details.issues`.

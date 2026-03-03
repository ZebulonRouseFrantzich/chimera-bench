---
name: agent-os-roadmap-sync
description: Keep agent-os/product/roadmap.md in sync with newly added specs.
argument-hint: "<spec-folder-path> [version-section]"
disable-model-invocation: true
---

Use this workflow whenever you add a new spec folder under `agent-os/specs/`.

## Procedure

1. Read the new spec's `plan.md`.
2. Extract:
   - spec display name (from the `plan.md` title)
   - a one-sentence description (from Objective/Deliverables; keep it short)
   - spec folder path
3. Update `agent-os/product/roadmap.md`:
   - Add a checkbox entry: `- [ ] <Spec Name> (<spec-folder-path>/)`.
   - Immediately below it, add an indented description line:
     - `  - <short description>`
   - Place the entry into the correct version section (for example `## v0.0.1`, `## v0.1.0`).
     - If a version section is not provided as an argument, infer the best fit from the roadmap structure.
4. Validate:
   - No duplicate entries for the same spec folder path.
   - Existing completion checkboxes remain unchanged.
   - Spec references use names/paths (avoid numeric "Spec N" identifiers).

## Guardrails

- Do not rename existing spec folders to satisfy ordering.
- Keep descriptions factual and stable (avoid implementation detail drift).

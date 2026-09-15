# Repair the architecture model

`archify validate` refused the model you wrote. Its diagnostics are below. Each
one names a stable `code`, the exact `subject` at fault, the `evidence` it
measured, and the `supportedFixes` it will accept.

Rules for this pass, from the archify authoring contract:

- Change **only** the diagnosed `subject`. A repair that also tidies something
  else makes the next diagnostic harder to attribute.
- Choose from `supportedFixes`. When a diagnostic hands you a concrete point
  (`labelAt`, a coordinate), use that value rather than estimating another one.
- Apply **at most one** diagnosed geometry control per repair — `via`,
  `channelX`, `channelY`, `labelAt`. Do not add them pre-emptively.
- A relationship label is semantic data. Move the label, then the route, then
  the spacing, and only then shorten the wording while keeping the meaning.
  Deleting a label is not a geometry repair.
- If the field at fault is `meta.quality_profile`, fix that before any geometry.

## Diagnostics

```json
{{DIAGNOSTICS}}
```

## The model to repair

The file is at `{{OUTPUT_PATH}}`. Read it, fix it, and write it back to the same
path. A single JSON object, nothing else.

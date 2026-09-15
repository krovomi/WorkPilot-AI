---
name: bmad-review-edge-case-hunter
description: 'Deprecated — forwards to bmad-review'
metadata:
  lifecycle: shim
  workpilot:
    # Not emitted, and not run by a workflow phase, until BMAD's own
    # installer has written `_bmad/` into the project being built. The
    # skill body below resolves its customization through that tree; without
    # it the procedure has nothing to read, which is the failure this gate
    # exists to turn into a sentence instead of a spent session.
    requires: { runtime: "_bmad/scripts/resolve_customization.py" }
---

Merged into `bmad-review`. Invoke the `bmad-review` skill on the same content with only the `edge-case-hunter` lens, passing through any `also_consider` areas. Output ONLY the raw findings JSON array in the legacy shape: the four standard fields (plus `kind`/`confidence` on deletion findings), no `lens` field, no markdown wrapping, no extra text. `[]` is valid when nothing is found.

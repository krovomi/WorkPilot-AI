---
name: bmad-editorial-review-structure
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

Merged into `bmad-review`. Invoke the `bmad-review` skill on the same content with only the `structure` lens, passing through the same inputs and any `also_consider` areas. Present the findings in the legacy report shape: a `## Document Summary` block (purpose, audience, reader type, structure model, current length), a `## Recommendations` list of numbered `[CUT/MERGE/MOVE/CONDENSE/QUESTION/PRESERVE]` entries each with rationale and word impact, and a closing `## Summary` (total recommendations, estimated reduction) — not the findings table. If no structural issues are found, output exactly: `No substantive changes recommended`.

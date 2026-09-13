---
name: bmad-review-verification-gap
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

Merged into `bmad-review`. Invoke the `bmad-review` skill on the same content with only the `verification-gap` lens. Present the markdown rendering only (no JSON block), listing any `gap_shape: "other"` findings under an `## Other findings` heading. When there are no findings at all, output exactly this single line: `No verification gaps found.`

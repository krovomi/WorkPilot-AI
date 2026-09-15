---
name: bmad-editorial-review-prose
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

Merged into `bmad-review`. Invoke the `bmad-review` skill on the same content with only the `prose` lens, passing through the same inputs and any `also_consider` areas. Present the findings in the legacy shape: a three-column markdown table `| Original Text | Revised Text | Changes |` — no Pass column, no preamble above the table. If no issues are found, output exactly: `No editorial issues identified`.

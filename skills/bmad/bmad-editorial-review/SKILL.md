---
name: bmad-editorial-review
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

Merged into `bmad-review`. Invoke the `bmad-review` skill on the same content with the `structure` and `prose` lenses — both, structure first, so prose runs on top of the structure findings — unless the caller asked for a structure-only or prose-only review, in which case pass only that lens. Pass through any `also_consider` areas, and forward this skill's resolved `[workflow]` fields as pre-resolved values — but only those that resolved to something, since an empty value here means no legacy override exists and bmad-review's own default should stand: `reader_type`, `style_guide`, `review_guidance`, `output_preferences`, `persistent_facts`, `activation_steps_prepend`, `activation_steps_append`, `on_complete`, and `review_output_path` as the report path. Present the findings in the legacy shape: the two-pass findings table `| Pass | Original Text | Revised Text | Changes |` with the purpose/audience read above it and, when the structure pass ran, the reduction summary below it — and no other lens's output.

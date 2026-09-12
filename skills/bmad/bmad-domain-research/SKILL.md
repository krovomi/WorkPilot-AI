---
name: bmad-domain-research
description: 'Deprecated — forwards to bmad-deep-recon (domain type)'
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

# DEPRECATED — forwards to bmad-deep-recon (domain type)

This skill was consolidated into `bmad-deep-recon`. It is retained as a thin compatibility shim so existing invocations by name and `_bmad/custom/bmad-domain-research.toml` override files keep working. New work should invoke `bmad-deep-recon` directly — it drafts deep-research prompts for outside tools, processes finished reports into downstream-ready summaries, and runs research directly, across market, domain, technical, competitive, user-voice, and academic-lit types (plus a select shape for choose-between decisions and custom types).

## On Activation

1. Resolve customization: `uv run {project-root}/_bmad/scripts/resolve_customization.py --skill {skill-root} --project-root {project-root} --key workflow`. This picks up any `{project-root}/_bmad/custom/bmad-domain-research.toml` and `bmad-domain-research.user.toml` overrides for the legacy fields (`activation_steps_prepend`, `activation_steps_append`, `persistent_facts`, `on_complete`).
2. Emit a deprecation notice to the user (in their configured communication language): `bmad-domain-research` is deprecated and forwards to `bmad-deep-recon` with the domain type. To silence this notice and access the full new surface (draft/process/run modes, research types, verification levels, HTML briefing, handoffs), migrate `_bmad/custom/bmad-domain-research.toml` to `_bmad/custom/bmad-deep-recon.toml` and invoke `bmad-deep-recon` directly.
3. Invoke `bmad-deep-recon` with: **research type** `domain` (skip its type inference), the four legacy fields above as pre-resolved values, and the user's original input verbatim. `bmad-deep-recon` takes the workflow from here — do not execute any further steps in this shim.

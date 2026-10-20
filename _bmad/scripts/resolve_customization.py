#!/usr/bin/env python3
"""workpilot-mock — not BMAD's runtime.

This file stands in for the one BMAD's installer writes into a project
(`npx bmad-method install --full`), so that `skills-cli build` emits the 50
vendored BMAD skills into `.agents/skills/` of THIS repository and
`build --check` gives the same answer locally and in CI (the `skills` job of
`.github/workflows/lint.yml` writes the same file on the runner).

It must FAIL, not succeed. Every BMAD skill's first step runs this script and
falls back to reading its own `customize.toml` "on failure"; a mock that
exits 0 with no data silences that fallback. The command palette and
`skills:bootstrap` recognise the marker on the first line and treat the
runtime as absent (`skills_registry.resolver.is_mock_runtime`).
"""

import sys

if __name__ == "__main__":
    sys.stderr.write(
        "resolve_customization.py: this is WorkPilot's mock, not BMAD's runtime. "
        "Install BMAD into this project (pnpm run skills:bootstrap -- --pack bmad "
        "--force) or read the skill's customize.toml directly.\n"
    )
    sys.exit(2)

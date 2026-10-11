"""This repository's own `[packs]` keeps `hermes-learned` out (audit F12).

`learning_loop/hermes_adopt.py` writes agent-authored skills into
`skills/hermes-learned/` without a person reading them first. What keeps that
prose away from every harness is not the adopter — it is that the pack is absent
from `.workpilot/skills.toml`, so `resolver.resolve` rejects each of its skills
at the `pack-pin` gate (shared_docs/architecture/hermes.md). One line in
`[packs]` lifts the gate for the whole pack, and that line belongs to a person,
in a pull request that says so; it once slipped in next to the other packs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.hermes_adopt import ADOPTED_PACK  # noqa: E402
from skills_registry.packs import load_packs  # noqa: E402
from skills_registry.project import load_project_config  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402


def test_the_adopted_pack_is_not_listed_in_this_repos_packs():
    config = load_project_config(REPO_ROOT)
    # An empty `[packs]` admits every pack (the want-list is opt-in only when
    # it lists something), so absence alone would prove nothing.
    assert config.packs, ".workpilot/skills.toml must keep a non-empty [packs]"
    assert ADOPTED_PACK not in config.packs, (
        f"`{ADOPTED_PACK}` is the learning loop's own output and must stay out "
        "of [packs]; see shared_docs/architecture/hermes.md"
    )


def test_an_adopted_skill_is_rejected_at_the_pack_pin_gate(tmp_path):
    """The gate, end to end: this repo's config against a populated pack."""
    pack = tmp_path / ADOPTED_PACK
    (pack / "adopted-procedure").mkdir(parents=True)
    (pack / "pack.json").write_text(
        json.dumps({"name": ADOPTED_PACK, "version": "0.0.1", "targets": {}}),
        encoding="utf-8",
    )
    (pack / "adopted-procedure" / "SKILL.md").write_text(
        "---\nname: adopted-procedure\ndescription: written by an agent\n---\n\nbody\n",
        encoding="utf-8",
    )

    result = resolve(load_packs(tmp_path), load_project_config(REPO_ROOT))

    assert "adopted-procedure" not in result.by_name()
    assert [r.gate for r in result.rejections_for("adopted-procedure")] == ["pack-pin"]

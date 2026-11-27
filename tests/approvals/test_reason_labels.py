"""Every reason code the engine gives has a label on the card, in en and fr."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DECIDE = ROOT / "apps" / "backend" / "approvals" / "decide.py"
LOCALES = ROOT / "apps" / "frontend" / "src" / "shared" / "i18n" / "locales"


def _codes() -> set[str]:
    text = DECIDE.read_text(encoding="utf-8")
    found = set(re.findall(r"\.add\(\s*\"([a-z_]+)\"", text))
    found |= set(re.findall(r"Reason\(\s*\"([a-z_]+)\"", text))
    return found


def test_the_engine_codes_are_found():
    assert {"sensitive_paths", "docs_only", "review_missing"} <= _codes()


def test_every_code_has_a_label_in_both_languages():
    for lang in ("en", "fr"):
        data = json.loads((LOCALES / lang / "tasks.json").read_text(encoding="utf-8"))
        labels = data["approvalTier"]["reasons"]
        assert _codes() <= set(labels), (lang, _codes() - set(labels))

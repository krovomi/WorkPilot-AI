"""The release builds run the REA audit on a Node.js the pinned REA accepts.

``release-exposure-audit.cjs`` refuses a Node.js outside ``pin.json``'s
``node`` ranges. Each build job of ``release.yml`` therefore asks for one of
those ranges, never a bare major that takes whatever the runner image caches.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIN = ROOT / "apps" / "backend" / "rea" / "pin.json"
RELEASE = ROOT / ".github" / "workflows" / "release.yml"

_SETUP = re.compile(
    r"uses: \./\.github/actions/setup-node-frontend\n"
    r"(?:\s+with:\n(?:\s+#.*\n)*\s+node-version: '([^']+)')?"
)


def test_every_release_build_asks_for_a_node_the_pin_accepts():
    accepted = json.loads(PIN.read_text(encoding="utf-8"))["node"]
    text = RELEASE.read_text(encoding="utf-8")
    audits = text.count("release-exposure-audit.cjs")
    versions = _SETUP.findall(text)
    assert audits and len(versions) == audits
    assert all(v in accepted for v in versions), (versions, accepted)

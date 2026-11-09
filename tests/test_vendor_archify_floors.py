"""The vendored archify tree keeps its dependency floors across re-vendoring."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDORED = ROOT / "apps" / "backend" / "vendor" / "archify"

_spec = importlib.util.spec_from_file_location(
    "vendor_archify", ROOT / "scripts" / "vendor_archify.py"
)
vendor_archify = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vendor_archify)


def _manifest(directory: Path, overrides: dict[str, str]) -> Path:
    path = directory / "package.json"
    path.write_text(
        json.dumps({"name": "archify", "overrides": overrides}), encoding="utf-8"
    )
    return path


def test_floors_replace_upstream_override_and_are_reported(tmp_path):
    path = _manifest(tmp_path, {"fast-uri": "3.1.5"})

    applied = vendor_archify._apply_floors(tmp_path)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["overrides"]["fast-uri"] == "^3.1.9"
    assert applied == ["overrides.fast-uri: '3.1.5' -> '^3.1.9'"]


def test_floors_already_in_place_change_nothing(tmp_path):
    path = _manifest(tmp_path, {"fast-uri": "^3.1.9"})
    before = path.read_text(encoding="utf-8")

    assert vendor_archify._apply_floors(tmp_path) == []
    assert path.read_text(encoding="utf-8") == before


def test_the_committed_tree_carries_every_floor():
    manifest = json.loads((VENDORED / "package.json").read_text(encoding="utf-8"))
    for name, floor in vendor_archify.DEPENDENCY_FLOORS.items():
        assert manifest["overrides"].get(name) == floor

    lock = json.loads((VENDORED / "package-lock.json").read_text(encoding="utf-8"))
    versions = [
        entry["version"]
        for key, entry in lock["packages"].items()
        if key.endswith("node_modules/fast-uri")
    ]
    assert versions, "fast-uri is no longer in the vendored lockfile"
    for version in versions:
        major, minor, patch = (int(part) for part in version.split("."))
        assert (major, minor, patch) >= (3, 1, 9), version

#!/usr/bin/env python3
"""Vendor the archify diagram renderer into `apps/backend/vendor/archify/`.

Archify is the renderer behind the Architecture page and the Kanban's
architecture delta. It is **committed** rather than fetched on demand, unlike
the skill packs under `skills/` — and the difference is the consumer, not a
change of heart. A pack is read by an agent working in someone's project; this
is a runtime dependency of two features of the desktop app. Making it optional
would mean a user installs the `.dmg`, opens the Architecture page, and reads
"not installed, run this command". 2.6 MB against an Electron binary is not a
trade worth making.

What is dropped, and why, is the whole content of this script:

``test/``
    Upstream's own suite, 2.0 MB. What matters to us is that `doctor` is green
    here, which the contract test asserts against the vendored tree itself.
``examples/*.html``
    3.9 MB of **rendered** artifacts. `SKILL.md` tells the author to read one
    matching JSON example; the JSON examples (92 KB) are kept, the renders are
    the output we generate ourselves.
``scripts/check-update.mjs``
    A checker that queries a remote manifest. An app that phones a third party
    in the middle of someone's build is not a decision to take silently — the
    update path here is re-running this script and reading the diff.

Usage::

    python3 scripts/vendor_archify.py                  # re-vendor at the pinned tag
    python3 scripts/vendor_archify.py --ref v2.17.0    # move the pin
    python3 scripts/vendor_archify.py --check          # report drift, write nothing
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SOURCE = "https://github.com/tt-a1i/archify"

# The skill package lives in a subdirectory of the repository; the repository
# root carries the project's own docs, benchmarks and a copy of the zip.
SKILL_SUBDIR = "archify"

DEFAULT_REF = "v2.16.0"

REPO_ROOT = Path(__file__).resolve().parent.parent

# `tree_digest` lives in the backend package: the script writes the manifest and
# the doctor and the contract test read it, so the definition has to be one.
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))
from architecture_visualizer.archify.runtime import (  # noqa: E402
    RECEIPT_NAME,
    file_digests,
    tree_digest,
)

DEST = REPO_ROOT / "apps" / "backend" / "vendor" / "archify"

# Directories taken whole. `delta/` is the architecture comparator, `recipes/`
# backs `guide`, `references/` is what SKILL.md defers its detail to, and
# `assets/template.html` is the renderer's shell.
KEEP_DIRS = (
    "bin",
    "renderers",
    "schemas",
    "assets",
    "references",
    "recipes",
    "delta",
    "migrations",
    "brand-marks",
    "scripts",
)

# Files that must be there. Vendoring third-party code without its licence is
# not something to do quietly, so a missing one fails the script rather than
# being skipped like the rest.
REQUIRED_FILES = ("SKILL.md", "LICENSE", "package.json")

# Taken when present. `THIRD_PARTY_NOTICES.md` only appears in some upstream
# releases; which of these were absent is recorded in VENDOR.json rather than
# passed over in silence, because "attribution quietly stopped being copied" is
# exactly the failure this list would otherwise hide.
OPTIONAL_FILES = (
    "THIRD_PARTY_NOTICES.md",
    "package-lock.json",
    "skill-release.json",
)

# Removed after the copy, by path relative to the vendored root.
DROP = ("scripts/check-update.mjs",)

EXCLUDED = (
    "test/",
    "examples/*.html",
    "scripts/check-update.mjs",
)


def _run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _clone(ref: str, into: Path) -> str:
    """Shallow-clone `ref` and return the commit it resolved to."""
    _run(["git", "clone", "--depth", "1", "--branch", ref, SOURCE, str(into)])
    return _run(["git", "rev-parse", "HEAD"], cwd=into)


def _stage(src: Path, staging: Path) -> list[str]:
    """Copy the kept tree into `staging`; return the optional files not found."""
    staging.mkdir(parents=True)
    for name in KEEP_DIRS:
        source = src / name
        if source.is_dir():
            shutil.copytree(source, staging / name)

    missing_required = [n for n in REQUIRED_FILES if not (src / n).is_file()]
    if missing_required:
        raise FileNotFoundError(
            "upstream is missing required file(s): " + ", ".join(missing_required)
        )
    for name in REQUIRED_FILES:
        shutil.copy2(src / name, staging / name)

    absent: list[str] = []
    for name in OPTIONAL_FILES:
        source = src / name
        if source.is_file():
            shutil.copy2(source, staging / name)
        else:
            absent.append(name)

    # Examples: the JSON sources only. SKILL.md reads one for field shape.
    examples = src / "examples"
    if examples.is_dir():
        (staging / "examples").mkdir()
        for entry in sorted(examples.glob("*.json")):
            shutil.copy2(entry, staging / "examples" / entry.name)

    for relative in DROP:
        target = staging / relative
        if target.exists():
            target.unlink()

    return absent


def _drifted(root: Path) -> list[str]:
    """Which files differ from the last vendoring, once the digest disagrees.

    One extra pass, and it turns "the tree changed" into "these three files
    changed" — the difference between a CI failure someone can act on and one
    they have to reproduce locally first.
    """
    try:
        recorded = json.loads((root / RECEIPT_NAME).read_text(encoding="utf-8")).get(
            "files"
        )
    except (OSError, json.JSONDecodeError):
        recorded = None
    if not isinstance(recorded, dict):
        # A tree vendored before this field existed. The digest already said
        # they differ; naming nothing is more honest than guessing.
        return []

    actual = file_digests(root)
    changed = [
        f"{name} ({'added' if name not in recorded else 'modified'})"
        for name, digest in actual.items()
        if recorded.get(name) != digest
    ]
    changed.extend(f"{name} (removed)" for name in sorted(set(recorded) - set(actual)))
    return sorted(changed)


def _receipt(
    ref: str, commit: str, absent: list[str], staging: Path
) -> dict[str, object]:
    return {
        "source": SOURCE,
        "subdir": SKILL_SUBDIR,
        "ref": ref,
        "commit": commit,
        "license": "MIT",
        "tree_sha256": tree_digest(staging),
        "files": file_digests(staging),
        "vendored_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vendored_by": "scripts/vendor_archify.py",
        "excluded": list(EXCLUDED),
        "absent_upstream": absent,
        "note": (
            "Committed rather than bootstrapped: this is a runtime dependency of "
            "the Architecture page and the Kanban architecture delta, not a skill "
            "pack. Re-run the script to move the pin; never hand-edit this tree."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default=DEFAULT_REF, help="tag or branch to pin")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report whether the vendored tree matches the pin, write nothing",
    )
    args = parser.parse_args(argv)

    receipt_path = DEST / RECEIPT_NAME
    if args.check:
        if not receipt_path.is_file():
            print(f"vendor_archify: {receipt_path} is missing", file=sys.stderr)
            return 1
        current = json.loads(receipt_path.read_text(encoding="utf-8"))
        if current.get("ref") != args.ref:
            print(
                f"vendor_archify: vendored at {current.get('ref')!r}, "
                f"expected {args.ref!r}",
                file=sys.stderr,
            )
            return 1

        # The pin matching is not the same as the tree matching. Three files in
        # here were once edited in place by an autofix bot, and re-running this
        # script silently reverted them, because nothing compared the bytes to
        # the commit the receipt names.
        expected = current.get("tree_sha256")
        if not expected:
            print(
                "vendor_archify: this tree predates the integrity manifest — "
                "re-run `python3 scripts/vendor_archify.py` to record it",
                file=sys.stderr,
            )
            return 1
        actual = tree_digest(DEST)
        if actual != expected:
            print(
                f"vendor_archify: the vendored tree does not match {args.ref}.\n"
                f"  expected tree_sha256 {expected[:16]}\n"
                f"  actual   tree_sha256 {actual[:16]}",
                file=sys.stderr,
            )
            for entry in _drifted(DEST):
                print(f"  {entry}", file=sys.stderr)
            print(
                "\nThis tree is a pinned copy of third-party code. Do not edit it "
                "in place: a re-vendoring reverts the edit without saying so. Fix "
                "it upstream, or restore it with "
                "`python3 scripts/vendor_archify.py`.",
                file=sys.stderr,
            )
            return 1

        print(
            f"vendor_archify: {args.ref} ({current.get('commit', '')[:12]}) "
            f"tree {actual[:12]}"
        )
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        clone = Path(tmp) / "archify"
        commit = _clone(args.ref, clone)
        src = clone / SKILL_SUBDIR
        if not (src / "SKILL.md").is_file():
            print(
                f"vendor_archify: no SKILL.md under {SKILL_SUBDIR}/ at {args.ref}",
                file=sys.stderr,
            )
            return 1

        staging = Path(tmp) / "staged"
        try:
            absent = _stage(src, staging)
        except FileNotFoundError as exc:
            print(f"vendor_archify: {exc}", file=sys.stderr)
            return 1
        (staging / RECEIPT_NAME).write_text(
            json.dumps(_receipt(args.ref, commit, absent, staging), indent="\t") + "\n",
            encoding="utf-8",
        )

        shutil.rmtree(DEST, ignore_errors=True)
        DEST.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staging, DEST)

    files = sum(1 for p in DEST.rglob("*") if p.is_file())
    size = sum(p.stat().st_size for p in DEST.rglob("*") if p.is_file())
    print(
        f"vendor_archify: {args.ref} ({commit[:12]}) -> {DEST.relative_to(REPO_ROOT)}"
    )
    print(f"vendor_archify: {files} files, {size / 1024 / 1024:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

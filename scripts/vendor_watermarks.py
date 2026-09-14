#!/usr/bin/env python3
"""Vendor the Layer A text cleaner of watermarks-remover into
`apps/backend/vendor/watermarks/`.

Upstream: https://github.com/guillaumemeyer/watermarks-remover (MIT). It is a
whole product — an HTTP service, image/PDF/audio metadata strippers, a
statistical rewrite layer, and optional PyTorch harnesses. **One file of it is
vendored**, and the trim is the interesting part:

``service/scripts/text_unicode.py``
    Layer A: the decision table that says which invisible codepoint is a
    watermark carrier and which is load-bearing — a ZWJ inside an emoji
    sequence, a joiner between two Arabic letters, a Hangul filler after a
    jamo. 25 KB, stdlib-only, no imports from the rest of upstream. This is
    the whole of what WorkPilot needs, because the files its agents generate
    are source code and Markdown.
``LICENSE``
    Required. Vendoring third-party code without its licence is not something
    to do quietly, so a missing one fails this script rather than being
    skipped.

Everything else is excluded because it has no consumer here, not because it is
bad: ``image_meta.py`` (86 KB) and ``container_meta.py`` (169 KB) strip EXIF and
docProps from files a coding agent does not write; ``rewrite_text.py`` (55 KB)
is Layer B, which removes statistical marks by paraphrasing — a build that
silently reworded the code it just wrote would be a different product;
``server.py`` is an HTTP service, and a localhost daemon that must be running
for a build to produce clean files is a dependency that fails closed on every
machine where nobody started it.

The decision table itself is **never reimplemented**. Same reasoning as
`rtk.rewrite` delegating to `rtk rewrite`: owning a second copy of a Unicode
policy in Python means two answers to one question, drifting apart silently —
and this one is subtle enough that the second copy would get the preservation
rules wrong long before anyone noticed.

Usage::

    python3 scripts/vendor_watermarks.py                 # re-vendor at the pinned tag
    python3 scripts/vendor_watermarks.py --ref v0.8.0    # move the pin
    python3 scripts/vendor_watermarks.py --check         # report drift, write nothing
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

SOURCE = "https://github.com/guillaumemeyer/watermarks-remover"

DEFAULT_REF = "v0.7.0"

REPO_ROOT = Path(__file__).resolve().parent.parent

# The manifest format is shared with `vendor/archify`; one definition of
# "is this tree the one it claims to be" for both trees.
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))
from core.vendor_manifest import (  # noqa: E402
    RECEIPT_NAME,
    file_digests,
    tree_digest,
)

DEST = REPO_ROOT / "apps" / "backend" / "vendor" / "watermarks"

#: Taken, by path in the upstream checkout, and written flat into the vendored
#: root. `text_unicode.py` imports nothing from its siblings — verified by
#: `tests/test_watermarks_vendor.py`, which is what makes the flat copy safe.
REQUIRED_FILES = {
    "service/scripts/text_unicode.py": "text_unicode.py",
    "LICENSE": "LICENSE",
}

#: Taken when present. Which of these upstream stopped shipping is recorded in
#: the receipt rather than passed over in silence — "attribution quietly
#: stopped being copied" is exactly the failure a silent skip would hide.
OPTIONAL_FILES = {
    "NOTICE": "NOTICE",
    "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
}

EXCLUDED = (
    "service/ (everything but text_unicode.py)",
    "skills/",
    "compose.yaml, Dockerfile*, Makefile",
    "tests/, docs/",
)


def _run(cmd: list[str], cwd: Path | None = None) -> str:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _clone(ref: str, into: Path) -> str:
    """Check `ref` out into `into` and return the commit it resolved to.

    Fetch-then-checkout rather than `clone --branch`, because `--branch` takes a
    tag or a branch and refuses a commit sha — and upstream's pin may well be a
    sha the day a fix lands that is not yet tagged.
    """
    into.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "--quiet"], cwd=into)
    _run(["git", "remote", "add", "origin", SOURCE], cwd=into)
    try:
        _run(["git", "fetch", "--quiet", "--depth", "1", "origin", ref], cwd=into)
        _run(["git", "checkout", "--quiet", "FETCH_HEAD"], cwd=into)
    except subprocess.CalledProcessError:
        # A server that refuses to serve an arbitrary sha in a want. Pay for the
        # full history once rather than failing the vendoring.
        _run(["git", "fetch", "--quiet", "origin"], cwd=into)
        _run(["git", "checkout", "--quiet", ref], cwd=into)
    return _run(["git", "rev-parse", "HEAD"], cwd=into)


def _stage(src: Path, staging: Path) -> list[str]:
    """Copy the kept files into `staging`; return the optional ones not found."""
    staging.mkdir(parents=True)

    missing = [name for name in REQUIRED_FILES if not (src / name).is_file()]
    if missing:
        raise FileNotFoundError(
            "upstream is missing required file(s): " + ", ".join(missing)
        )
    for name, target in REQUIRED_FILES.items():
        shutil.copy2(src / name, staging / target)

    absent: list[str] = []
    for name, target in OPTIONAL_FILES.items():
        if (src / name).is_file():
            shutil.copy2(src / name, staging / target)
        else:
            absent.append(name)
    return absent


def _drifted(root: Path) -> list[str]:
    """Which files differ from the last vendoring, once the digest disagrees.

    One extra pass, and it turns "the tree changed" into "this file changed" —
    the difference between a CI failure someone can act on and one they have to
    reproduce locally first.
    """
    try:
        recorded = json.loads((root / RECEIPT_NAME).read_text(encoding="utf-8")).get(
            "files"
        )
    except (OSError, json.JSONDecodeError):
        recorded = None
    if not isinstance(recorded, dict):
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
        "ref": ref,
        "commit": commit,
        "license": "MIT",
        "tree_sha256": tree_digest(staging),
        "files": file_digests(staging),
        "paths": dict(REQUIRED_FILES),
        "vendored_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "vendored_by": "scripts/vendor_watermarks.py",
        "excluded": list(EXCLUDED),
        "absent_upstream": absent,
        "note": (
            "Layer A only: the Unicode decision table, which every generated file "
            "passes through. Committed rather than fetched on demand because a "
            "build that produces clean files only on machines where somebody ran "
            "an install command is a build whose output nobody can rely on. "
            "Re-run the script to move the pin; never hand-edit this tree."
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default=DEFAULT_REF, help="tag, branch or commit")
    parser.add_argument(
        "--check",
        action="store_true",
        help="report whether the vendored tree matches the pin, write nothing",
    )
    args = parser.parse_args(argv)

    receipt_path = DEST / RECEIPT_NAME
    if args.check:
        if not receipt_path.is_file():
            print(f"vendor_watermarks: {receipt_path} is missing", file=sys.stderr)
            return 1
        current = json.loads(receipt_path.read_text(encoding="utf-8"))
        if current.get("ref") != args.ref:
            print(
                f"vendor_watermarks: vendored at {current.get('ref')!r}, "
                f"expected {args.ref!r}",
                file=sys.stderr,
            )
            return 1

        # The pin matching is not the same as the tree matching: a formatter or
        # an autofix bot editing a vendored file in place leaves the pin intact
        # and the bytes wrong, and re-running this script would then silently
        # revert work somebody did on purpose.
        expected = current.get("tree_sha256")
        if not expected:
            print(
                "vendor_watermarks: this tree predates the integrity manifest — "
                "re-run `python3 scripts/vendor_watermarks.py` to record it",
                file=sys.stderr,
            )
            return 1
        actual = tree_digest(DEST)
        if actual != expected:
            print(
                f"vendor_watermarks: tree digest {actual} != recorded {expected}",
                file=sys.stderr,
            )
            for entry in _drifted(DEST):
                print(f"  - {entry}", file=sys.stderr)
            return 1
        print(f"vendor_watermarks: {args.ref} @ {current.get('commit', '?')[:12]} — ok")
        return 0

    with tempfile.TemporaryDirectory() as tmp:
        checkout = Path(tmp) / "upstream"
        commit = _clone(args.ref, checkout)
        staging = Path(tmp) / "staging"
        absent = _stage(checkout, staging)
        receipt = _receipt(args.ref, commit, absent, staging)
        (staging / RECEIPT_NAME).write_text(
            json.dumps(receipt, indent="\t") + "\n", encoding="utf-8"
        )
        if DEST.exists():
            shutil.rmtree(DEST)
        DEST.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(staging, DEST)

    kept = sorted(
        p.relative_to(DEST).as_posix() for p in DEST.rglob("*") if p.is_file()
    )
    print(f"vendor_watermarks: {args.ref} @ {commit[:12]} -> {DEST}")
    for name in kept:
        print(f"  {name}")
    if absent:
        print("  (absent upstream: " + ", ".join(absent) + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

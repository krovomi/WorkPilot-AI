#!/usr/bin/env python3
"""Vendor the BMAD Method skills into `skills/bmad/`, pinned to one version.

BMAD v6.0 shipped *pointers*: each skill was a four-line wrapper telling the
model to open `@_bmad/core/tasks/workflow.xml` and follow it. That shape is
gone. From v6.7 upstream ships real Agent Skills — the procedure is in the
`SKILL.md`, next to the `references/`, `assets/` and `customize.toml` it reads —
and the paths the old wrappers named (`_bmad/core/tasks/`, `_bmad/bmm/agents/`,
`_bmad/bmm/workflows/`) are not created by the installer any more.

So the 76 wrappers in this repository were not merely stale, they were
unrunnable against every BMAD installation the pinned installer produces: the
`spec` phase opened `bmad-bmm-create-prd`, was told to read
`_bmad/bmm/workflows/2-plan-workflows/create-prd/workflow-create-prd.md`, and
spent a whole session looking for a file this version of BMAD never writes.

What is vendored, and what is not
---------------------------------
The **skills** are vendored — the whole directory, because a `SKILL.md` that
says "load `references/validate.md`" is not a skill without it.

The **runtime** is not. `_bmad/` holds the project's own configuration
(`config.yaml`, the `custom/` overrides, the `scripts/` the skills shell out
to) and is written by BMAD's installer into the project being built, per
project. It is the thing `bootstrap` installs and the thing `requires` gates
on, and it is deliberately not in this repository: it is not ours, and it
differs per project by design.

Every vendored skill therefore carries

    metadata.workpilot.requires: { runtime: "_bmad/scripts/resolve_customization.py" }

which is the one path every v6 skill uses — step 1 of each of them resolves its
customization through it — and which the installer writes for every module. A
gate per module would be more precise and less true: a bmm skill with the core
scripts missing is just as unable to start.

Usage
-----
    python3 scripts/vendor_bmad.py                 # re-vendor the pinned version
    python3 scripts/vendor_bmad.py --version 6.12.0
    python3 scripts/vendor_bmad.py --check         # fail if the tree has drifted

`--check` is what CI can run: it re-vendors into a temporary directory and
compares, so "someone hand-edited a vendored skill" is a failure rather than a
surprise at the next update.
"""

from __future__ import annotations

import argparse
import filecmp
import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACK_DIR = REPO_ROOT / "skills" / "bmad"
VENDOR_RECORD = PACK_DIR / "VENDOR.json"

PACKAGE = "bmad-method"
REGISTRY = "https://registry.npmjs.org"

# The roots inside the tarball that hold skills. Each immediate subdirectory
# containing a SKILL.md is one skill; `v6-shims/` nests one level deeper, and
# the walk below finds those too rather than naming them.
SKILL_ROOTS = ("package/src/core-skills", "package/src/bmm-skills")

# The one file every v6 skill's first step reads. See the module docstring.
RUNTIME_GATE = "_bmad/scripts/resolve_customization.py"

# Written into every vendored SKILL.md above the upstream frontmatter fields.
# Phrased for whoever opens the file wondering why it is not in the palette.
REQUIRES_COMMENT = (
    "# Not emitted, and not run by a workflow phase, until BMAD's own\n"
    "# installer has written `_bmad/` into the project being built. The\n"
    "# skill body below resolves its customization through that tree; without\n"
    "# it the procedure has nothing to read, which is the failure this gate\n"
    "# exists to turn into a sentence instead of a spent session.\n"
)

# Files upstream ships beside a skill that are of no use to a consumer here.
SKIP_NAMES = {".DS_Store", "__pycache__"}


def _fetch_metadata() -> dict:
    with urllib.request.urlopen(f"{REGISTRY}/{PACKAGE}", timeout=60) as response:  # noqa: S310
        return json.load(response)


def _resolve(version: str | None) -> tuple[str, str]:
    """(version, tarball url). `None` means whatever npm calls latest."""
    meta = _fetch_metadata()
    resolved = version or meta["dist-tags"]["latest"]
    if resolved not in meta["versions"]:
        raise SystemExit(f"vendor_bmad: {PACKAGE}@{resolved} is not published")
    return resolved, meta["versions"][resolved]["dist"]["tarball"]


def _download(url: str, into: Path) -> tuple[Path, str]:
    archive = into / "package.tgz"
    with urllib.request.urlopen(url, timeout=300) as response:  # noqa: S310
        payload = response.read()
    archive.write_bytes(payload)
    return archive, hashlib.sha256(payload).hexdigest()


def _extract(archive: Path, into: Path) -> Path:
    with tarfile.open(archive) as tar:
        members = [m for m in tar.getmembers() if _is_safe(m.name)]
        # `filter="data"` refuses absolute paths, links out of the tree and
        # device nodes. Belt and braces with the check above: this unpacks a
        # third-party archive.
        tar.extractall(into, members=members, filter="data")
    return into


def _is_safe(name: str) -> bool:
    parts = Path(name).parts
    return ".." not in parts and not Path(name).is_absolute()


def _skill_dirs(tree: Path) -> list[Path]:
    """Every directory under the skill roots that holds a SKILL.md."""
    found: list[Path] = []
    for root in SKILL_ROOTS:
        base = tree / root
        if not base.is_dir():
            continue
        found += [p.parent for p in sorted(base.rglob("SKILL.md"))]
    return found


def _frontmatter_name(skill_md: Path) -> str:
    """The skill's declared `name`, which is also its output directory.

    Read with the repository's own parser so a name this script accepts is a
    name the resolver accepts. Falls back to the directory name, which upstream
    keeps in step with the frontmatter.
    """
    sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))
    from skills_registry.frontmatter import parse_frontmatter

    meta, _body = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    return str(meta.get("name") or skill_md.parent.name)


def _with_requires(text: str) -> str:
    """Add the WorkPilot runtime gate to an upstream SKILL.md.

    Appended to the frontmatter as text rather than by re-serialising the
    parsed YAML: upstream writes long single-quoted descriptions and inline
    blocks, and a round trip through a dumper would rewrite every one of them,
    turning "BMAD changed a description" into a diff nobody can read.
    """
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise SystemExit("vendor_bmad: a SKILL.md without frontmatter")
    for index in range(1, len(lines)):
        if lines[index].strip() != "---":
            continue
        block = "".join(lines[1:index])
        if "workpilot:" in block:  # already carries ours
            return text
        injected = (
            "metadata:\n"
            "  workpilot:\n"
            + "".join(f"    {line}\n" for line in REQUIRES_COMMENT.splitlines())
            + f'    requires: {{ runtime: "{RUNTIME_GATE}" }}\n'
        )
        if "metadata:" in block:
            # Upstream's own `metadata:` (the shims carry `lifecycle: shim`)
            # takes the workpilot key as a sibling rather than a second
            # top-level `metadata:`, which YAML would silently collapse.
            injected = (
                "  workpilot:\n"
                + "".join(f"    {line}\n" for line in REQUIRES_COMMENT.splitlines())
                + f'    requires: {{ runtime: "{RUNTIME_GATE}" }}\n'
            )
            block = block.rstrip("\n") + "\n" + injected
            return "".join([lines[0], block, *lines[index:]])
        return "".join([lines[0], block, injected, *lines[index:]])
    raise SystemExit("vendor_bmad: unterminated frontmatter")


def _copy_skill(source: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for item in sorted(source.rglob("*")):
        if any(part in SKIP_NAMES for part in item.relative_to(source).parts):
            continue
        target = dest / item.relative_to(source)
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
    skill_md = dest / "SKILL.md"
    skill_md.write_text(
        _with_requires(skill_md.read_text(encoding="utf-8")), encoding="utf-8"
    )


def _write_pack_json(version: str, count: int) -> None:
    path = PACK_DIR / "pack.json"
    pack = json.loads(path.read_text(encoding="utf-8"))
    pack["version"] = version
    pack["description"] = (
        f"BMAD Method v{version} — the planning, shipping, review and agent "
        f"skills, vendored from the npm package and pinned by "
        f"scripts/vendor_bmad.py."
    )
    pack["source"] = "bmad-code-org/bmad-method"
    pack["bootstrap"] = {
        # Pinned to the vendored version rather than the `6` major: the skills
        # and the runtime are one release. `--full` because a skill gated on a
        # runtime the user chose not to install is a skill that never appears.
        "command": ["npx", "--yes", f"bmad-method@{version}", "install", "--full"],
        "produces": RUNTIME_GATE,
        "note": (
            "Writes the _bmad/ runtime into the project being built: its "
            "config, its custom/ overrides and the scripts every skill "
            "resolves its customization through. Per project, not per "
            "checkout, which is why it is not committed."
        ),
    }
    path.write_text(
        json.dumps(pack, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )
    _write_vendor_record(version, count)


def _write_vendor_record(version: str, count: int) -> None:
    VENDOR_RECORD.write_text(
        json.dumps(
            {
                "package": PACKAGE,
                "version": version,
                "registry": REGISTRY,
                "upstream": "https://github.com/bmad-code-org/bmad-method",
                "license": "MIT",
                "skills": count,
                "runtime_gate": RUNTIME_GATE,
                "vendored_by": "scripts/vendor_bmad.py",
                "note": (
                    "Skills only. The _bmad/ runtime they read is installed "
                    "per project by the bootstrap command in pack.json."
                ),
            },
            indent="\t",
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


def _vendor(version: str | None, into: Path) -> tuple[str, int]:
    resolved, url = _resolve(version)
    with tempfile.TemporaryDirectory() as raw:
        work = Path(raw)
        archive, digest = _download(url, work)
        tree = _extract(archive, work / "unpacked")
        print(f"vendor_bmad: {PACKAGE}@{resolved} (sha256 {digest[:16]}…)")

        licence = tree / "package" / "LICENSE"
        if not licence.is_file():
            raise SystemExit("vendor_bmad: upstream shipped no LICENSE — refusing")

        skills = _skill_dirs(tree)
        if not skills:
            raise SystemExit("vendor_bmad: no SKILL.md found in the package")

        for existing in sorted(into.iterdir()) if into.is_dir() else []:
            if existing.is_dir():
                shutil.rmtree(existing)
        into.mkdir(parents=True, exist_ok=True)

        names: set[str] = set()
        for skill_dir in skills:
            name = _frontmatter_name(skill_dir / "SKILL.md")
            if name in names:
                raise SystemExit(f"vendor_bmad: two skills named {name!r}")
            names.add(name)
            _copy_skill(skill_dir, into / name)

        shutil.copy2(licence, into / "LICENSE")
    return resolved, len(names)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", help="npm version to pin (default: latest)")
    parser.add_argument(
        "--check",
        action="store_true",
        help="re-vendor into a temporary tree and fail on any difference",
    )
    args = parser.parse_args()

    if not args.check:
        version, count = _vendor(args.version, PACK_DIR)
        _write_pack_json(version, count)
        print(f"vendor_bmad: {count} skills written to {PACK_DIR}")
        print("vendor_bmad: run `pnpm run skills:build` next")
        return 0

    pinned = json.loads(VENDOR_RECORD.read_text(encoding="utf-8"))["version"]
    with tempfile.TemporaryDirectory() as raw:
        candidate = Path(raw) / "bmad"
        candidate.mkdir()
        _vendor(args.version or pinned, candidate)
        drift = _compare(PACK_DIR, candidate)
    if drift:
        print("vendor_bmad: the vendored tree has drifted from upstream:")
        for line in drift[:40]:
            print(f"  {line}")
        if len(drift) > 40:
            print(f"  … and {len(drift) - 40} more")
        print("vendor_bmad: re-run `python3 scripts/vendor_bmad.py` to restore it")
        return 1
    print(f"vendor_bmad: {PACK_DIR} matches {PACKAGE}@{pinned}")
    return 0


def _compare(current: Path, expected: Path) -> list[str]:
    """Paths that differ, ignoring the files this script maintains itself."""
    ignored = {"pack.json", "VENDOR.json"}
    drift: list[str] = []
    here = {
        p.relative_to(current)
        for p in current.rglob("*")
        if p.is_file() and p.name not in ignored
    }
    there = {p.relative_to(expected) for p in expected.rglob("*") if p.is_file()}
    drift += [f"unexpected: {p}" for p in sorted(here - there)]
    drift += [f"missing: {p}" for p in sorted(there - here)]
    drift += [
        f"modified: {p}"
        for p in sorted(here & there)
        if not filecmp.cmp(current / p, expected / p, shallow=False)
    ]
    return drift


if __name__ == "__main__":
    raise SystemExit(main())

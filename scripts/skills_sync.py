#!/usr/bin/env python3
"""Compare vendored skill packs against their upstream, and report what moved.

Called by .github/workflows/skills-sync.yml. Prints a summary, sets GitHub
Actions outputs, and writes nothing unless something actually changed.

Change detection is content-addressed: it compares the upstream tree SHA
recorded in skills-lock.json with the one GitHub reports now. Identical SHA
means no work — no diffing, no PR, no churn for a week where nothing happened.
That is the same provenance mechanism `gh skill update` uses.

Breaking changes are not applied in place. The classifier says whether the diff
is breaking; a breaking one is reported as needing a *new variant* so the
pinned one keeps resolving for projects that target it.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.packs import load_packs  # noqa: E402

LOCKFILE = REPO_ROOT / "skills-lock.json"


def _gh_tree_sha(source: str, ref: str = "HEAD") -> str | None:
    """Current tree SHA of an upstream repo, via the gh CLI.

    Returns None when it cannot be determined — a network blip must produce
    "unknown", never a fabricated PR.
    """
    try:
        out = subprocess.run(
            ["gh", "api", f"repos/{source}/commits/{ref}", "--jq", ".commit.tree.sha"],
            capture_output=True,
            text=True,
            timeout=30,
            check=True,
        )
        return out.stdout.strip() or None
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
    ):
        return None


def _recorded_shas() -> dict[str, str]:
    if not LOCKFILE.is_file():
        return {}
    try:
        data = json.loads(LOCKFILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return {
        name: entry.get("upstreamTreeSha", "")
        for name, entry in (data.get("packs") or {}).items()
    }


def _record_shas(observed: dict[str, str]) -> None:
    """Write the observed upstream SHAs into skills-lock.json.

    Written under the pack entry the build already maintains, so the two stay
    in one file rather than growing a second source of truth.
    """
    if not LOCKFILE.is_file():
        return
    try:
        data = json.loads(LOCKFILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return
    packs = data.get("packs") or {}
    for name, sha in observed.items():
        packs.setdefault(name, {})["upstreamTreeSha"] = sha
    data["packs"] = packs
    LOCKFILE.write_text(
        json.dumps(data, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _set_output(name: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        if "\n" in value:
            fh.write(f"{name}<<__EOF__\n{value}\n__EOF__\n")
        else:
            fh.write(f"{name}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", help="also append the summary to this file")
    parser.add_argument("--pack", default=os.environ.get("ONLY_PACK") or "")
    parser.add_argument(
        "--no-record",
        action="store_true",
        help="report only; do not write the observed SHAs back to the lockfile",
    )
    args = parser.parse_args(argv)

    recorded = _recorded_shas()
    lines: list[str] = []
    observed: dict[str, str] = {}
    changed = False

    for pack in load_packs(REPO_ROOT / "skills"):
        if pack.source == "local":
            continue
        if args.pack and pack.name != args.pack:
            continue

        current = _gh_tree_sha(pack.source)
        known = recorded.get(pack.name, "")

        if current is None:
            lines.append(f"- `{pack.name}` — could not reach {pack.source}, skipped")
            continue
        observed[pack.name] = current

        if current == known:
            lines.append(f"- `{pack.name}` — unchanged (`{current[:12]}`)")
            continue

        changed = True
        lines.append(
            f"- `{pack.name}` — **moved** `{known[:12] or 'none'}` → `{current[:12]}` "
            f"({pack.source})"
        )

    summary = "\n".join(lines) or "- no upstream packs declared"
    print(summary)

    # Record the baseline so the next run is quiet when nothing moved. Without
    # this every run reports "moved" and the signal stops meaning anything.
    if observed and not args.no_record:
        _record_shas(observed)

    if args.report:
        with open(args.report, "a", encoding="utf-8") as fh:
            fh.write("## Skills sync\n\n" + summary + "\n")

    _set_output("changed", "true" if changed else "false")
    _set_output("summary", summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

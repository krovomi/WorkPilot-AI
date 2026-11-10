"""One dossier per pull request: who wrote it, from what, checked how (P5).

"Who wrote this code, with which model, from which dependencies?" becomes an
audit question once the EU Cyber Resilience Act and the AI Act apply. Each
answer already exists somewhere in the task, in a file a feature writes:

* **attribution**: the Agent Trace summary (F3, `agent_trace.summarize`): of
  the lines the task adds, how many an agent wrote, with which model;
* **dependencies**: the dependency guard's record (F2,
  `dependency_guard.json`): each package the task added and its verdict;
* **SBOM of the diff**: the packages the task's manifests add against the
  merge base, as a CycloneDX 1.6 document with a package URL each, for every
  ecosystem the guard reads (npm, PyPI, NuGet, Maven, Cargo, Go, Composer,
  pub, RubyGems). Manifests declare names, not resolved versions, so a
  component carries no version rather than a guessed one;
* **gates**: what the workflow's hard gates said at the end of the build
  (`hard_gates.json`, `workflows/hard_gates.py`), and the verification's
  verdict (`verify/verify.json`).

`write_dossier` gathers them into `<spec>/provenance/` (`dossier.json`,
`sbom.cdx.json`, `dossier.md`), and the PR body carries a short block of it
(`pr_block`). A part whose source is absent is recorded as absent, never
guessed; building the dossier never fails a build or a PR. It holds paths,
counts, package names, verdicts and model names only: no code, no prompt, no
secret. The compliance collector reads `dossier.json` as evidence of a change.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from foundation.git_executable import run_git

logger = logging.getLogger(__name__)

__all__ = [
    "DOSSIER_DIR",
    "DOSSIER_FILE",
    "SBOM_FILE",
    "build_dossier",
    "dossier_markdown",
    "pr_block",
    "purl",
    "write_dossier",
]

DOSSIER_DIR = "provenance"
DOSSIER_FILE = "dossier.json"
SBOM_FILE = "sbom.cdx.json"
MARKDOWN_FILE = "dossier.md"
VERSION = 1
MAX_COMPONENTS = 500

#: The dependency guard's ecosystems, as package URL types.
_PURL_TYPES = {
    "npm": "npm",
    "pypi": "pypi",
    "nuget": "nuget",
    "maven": "maven",
    "cargo": "cargo",
    "go": "golang",
    "packagist": "composer",
    "pub": "pub",
    "rubygems": "gem",
}


def purl(ecosystem: str, name: str) -> str | None:
    """The package URL of a declared package, without a version (none is known)."""
    kind = _PURL_TYPES.get(ecosystem)
    if not kind or not name:
        return None
    if kind == "maven":
        group, _, artifact = name.partition(":")
        if not artifact:
            return None
        return f"pkg:maven/{quote(group, safe='.-_')}/{quote(artifact, safe='.-_')}"
    if kind == "npm" and name.startswith("@") and "/" in name:
        scope, _, bare = name.partition("/")
        return f"pkg:npm/{quote(scope)}/{quote(bare, safe='.-_~')}"
    if kind == "pypi":
        name = name.lower().replace("_", "-")
    # Go module paths and Composer vendor/package keep their slashes.
    return f"pkg:{kind}/{quote(name, safe='/.-_~')}"


# -- reading the sources -------------------------------------------------------


def _json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _first(spec_dirs: list[Path], relative: str) -> dict | None:
    for spec in spec_dirs:
        found = _json(spec / relative)
        if found is not None:
            return found
    return None


def _git(project: Path, *args: str) -> str | None:
    try:
        result = run_git(list(args), cwd=project, timeout=30)
    except (OSError, ValueError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _base(project: Path, spec_dirs: list[Path], hints: list[str | None]) -> str:
    """The merge base the task is measured against: the one its own records
    used when they name it, else the merge base with its base branch."""
    for hint in hints:
        if hint:
            return hint
    from foundation.base_branch import detect_base_branch

    branch = detect_base_branch(spec_dirs[0] if spec_dirs else project, project)
    for ref in (f"origin/{branch}", branch):
        found = _git(project, "merge-base", "HEAD", ref)
        if found:
            return found
    return ""


def _changed_files(project: Path, base: str) -> list[str]:
    files: list[str] = []
    if base:
        out = _git(project, "diff", "--name-only", base, "HEAD")
        files += (out or "").splitlines()
    out = _git(project, "status", "--porcelain")
    files += [line[3:].strip() for line in (out or "").splitlines() if len(line) > 3]
    return sorted({f for f in files if f and not f.startswith(".workpilot/")})


def _attribution(project: Path, spec_dirs: list[Path]) -> dict | None:
    from agent_trace import summarize

    for spec in spec_dirs:
        try:
            summary = summarize(project, spec)
        except (OSError, ValueError):
            summary = None
        if summary:
            totals = summary.get("totals") or {}
            return {
                "base": summary.get("base") or "",
                "totals": {
                    k: int(totals.get(k) or 0)
                    for k in ("added", "ai", "human", "unknown")
                },
                "models": dict(summary.get("models") or {}),
                "files": len(summary.get("files") or {}),
            }
    return None


def _dependencies(spec_dirs: list[Path]) -> dict | None:
    from dependency_guard import RECORD_FILE

    record = _first(spec_dirs, RECORD_FILE)
    if record is None:
        return None
    return {
        "base": record.get("base") or "",
        "status": record.get("status") or "unknown",
        "checked_at": record.get("checked_at") or "",
        "findings": [
            {
                k: f.get(k, "")
                for k in ("ecosystem", "name", "manifest", "verdict", "reason")
            }
            for f in record.get("findings") or []
            if isinstance(f, dict)
        ][:MAX_COMPONENTS],
        "unchecked": record.get("unchecked") or "",
    }


def _sbom(project: Path, base: str, files: list[str], head: str) -> dict | None:
    """A CycloneDX 1.6 document of the packages the diff adds."""
    if not base:
        return None
    from dependency_guard import added_packages

    try:
        added = added_packages(project, base, files)
    except (OSError, ValueError):
        return None
    components = []
    for package in added.packages[:MAX_COMPONENTS]:
        url = purl(package.ecosystem, package.name)
        component = {
            "type": "library",
            "name": package.name,
            "properties": [
                {"name": "workpilot:ecosystem", "value": package.ecosystem},
                {"name": "workpilot:manifest", "value": package.manifest},
            ],
        }
        if url:
            component["purl"] = url
            component["bom-ref"] = url
        components.append(component)
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": f"urn:uuid:{uuid.uuid4()}",
        "version": 1,
        "metadata": {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tools": {"components": [{"type": "application", "name": "WorkPilot AI"}]},
            "properties": [
                {"name": "workpilot:scope", "value": "packages added by the diff"},
                {"name": "workpilot:base", "value": base},
                {"name": "workpilot:head", "value": head},
            ],
        },
        "components": components,
        "properties": [
            {"name": "workpilot:unreadable", "value": path} for path in added.unreadable
        ],
    }


def _gates(spec_dirs: list[Path]) -> dict | None:
    record = _first(spec_dirs, "hard_gates.json")
    if record is None:
        return None
    results = [
        {
            "phase": str(r.get("phase_id") or ""),
            "gate": str(r.get("gate") or ""),
            "held": r.get("held") if r.get("held") in (True, False) else None,
            "detail": str(r.get("detail") or "")[:200],
        }
        for r in record.get("results") or []
        if isinstance(r, dict)
    ]
    return {"blocking": bool(record.get("blocking")), "results": results}


def _verification(spec_dirs: list[Path]) -> dict | None:
    record = _first(spec_dirs, "verify/verify.json")
    if record is None:
        return None
    return {
        "status": str(record.get("status") or "unknown"),
        "reason": str(record.get("reason") or "")[:200],
        "score": record.get("score")
        if isinstance(record.get("score"), int | float)
        else None,
    }


# -- the dossier ---------------------------------------------------------------


def build_dossier(project_dir: Path | str, spec_dirs: list[Path | str]) -> dict:
    """Every part of the dossier from what the task left; an absent part is None.

    ``spec_dirs``: the copies of the spec to read, the most recent first (the
    worktree's, then the project's)."""
    project = Path(project_dir)
    specs = [Path(s) for s in spec_dirs if s]
    attribution = _attribution(project, specs)
    dependencies = _dependencies(specs)
    base = _base(
        project,
        specs,
        [(attribution or {}).get("base"), (dependencies or {}).get("base")],
    )
    head = _git(project, "rev-parse", "HEAD") or ""
    files = _changed_files(project, base)
    return {
        "version": VERSION,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "task": specs[0].name if specs else "",
        "base": base,
        "head": head,
        "changed_files": len(files),
        "attribution": attribution,
        "dependencies": dependencies,
        "sbom": _sbom(project, base, files, head),
        "gates": _gates(specs),
        "verification": _verification(specs),
    }


def _held(value: bool | None) -> str:
    return "✓" if value is True else "✗" if value is False else "?"


def _attribution_text(attribution: dict | None) -> str:
    if not attribution or not attribution["totals"]["added"]:
        return "no Agent Trace record"
    totals = attribution["totals"]
    share = round(100 * totals["ai"] / totals["added"])
    models = (
        ", ".join(f"`{m}`" for m in sorted(attribution["models"])) or "no model named"
    )
    return (
        f"{share} % of the {totals['added']} added lines from an agent ({models}), "
        f"{totals['human']} by a person, {totals['unknown']} unattributed"
    )


def _summary_lines(dossier: dict) -> list[str]:
    deps = dossier.get("dependencies")
    sbom = dossier.get("sbom")
    gates = dossier.get("gates")
    verification = dossier.get("verification")
    lines = [
        f"- **Attribution**: {_attribution_text(dossier.get('attribution'))}",
        "- **Dependencies added**: "
        + (
            f"{len(sbom['components'])} in the SBOM of the diff"
            if sbom is not None
            else "unknown (no base to compare with)"
        )
        + (
            f", guard verdict `{deps['status']}`"
            if deps
            else ", dependency guard did not run"
        ),
        "- **Gates**: "
        + (
            ", ".join(f"{_held(r['held'])} {r['gate']}" for r in gates["results"])
            or "none declared"
            if gates
            else "not recorded"
        ),
        "- **Verification**: "
        + (f"`{verification['status']}`" if verification else "not recorded"),
    ]
    return lines


def dossier_markdown(dossier: dict) -> str:
    """The dossier for a person to read."""
    lines = [
        f"# Provenance dossier: {dossier.get('task') or 'task'}",
        "",
        f"Base `{(dossier.get('base') or '?')[:12]}`, head `{(dossier.get('head') or '?')[:12]}`, "
        f"{dossier.get('changed_files', 0)} changed file(s), generated {dossier.get('generated_at')}.",
        "",
        *_summary_lines(dossier),
    ]
    deps = dossier.get("dependencies") or {}
    if deps.get("findings"):
        lines += [
            "",
            "## Dependencies checked",
            "",
            "| Ecosystem | Package | Verdict | Reason |",
            "|---|---|---|---|",
        ]
        for f in deps["findings"]:
            reason = str(f.get("reason") or "").replace("|", "\\|")
            lines.append(
                f"| {f['ecosystem']} | `{f['name']}` | {f['verdict']} | {reason} |"
            )
    gates = dossier.get("gates") or {}
    if gates.get("results"):
        lines += ["", "## Gates", ""]
        lines += [
            f"- {_held(r['held'])} `{r['gate']}` ({r['phase']})"
            + (f": {r['detail']}" if r["detail"] else "")
            for r in gates["results"]
        ]
    lines += [
        "",
        f"The machine-readable dossier is `{DOSSIER_FILE}`, the SBOM of the diff `{SBOM_FILE}` "
        "(CycloneDX 1.6; manifests declare names, so components carry no version).",
    ]
    return "\n".join(lines) + "\n"


def pr_block(dossier: dict | None) -> str:
    """The few lines of the dossier a pull request body carries, or ``""``."""
    if not dossier:
        return ""
    parts = [
        dossier.get(k)
        for k in ("attribution", "dependencies", "sbom", "gates", "verification")
    ]
    if not any(parts):
        return ""
    return "\n".join(
        [
            "<details><summary>Provenance dossier</summary>",
            "",
            *_summary_lines(dossier),
            "",
            "</details>",
        ]
    )


def write_dossier(
    project_dir: Path | str,
    spec_dirs: list[Path | str],
    target: Path | str | None = None,
) -> dict | None:
    """Build the dossier and write it into ``target`` (default: the first spec
    copy). Never raises."""
    specs = [Path(s) for s in spec_dirs if s]
    if not specs:
        return None
    try:
        dossier = build_dossier(project_dir, specs)
        folder = Path(target or specs[0]) / DOSSIER_DIR
        if folder.is_symlink():
            raise OSError("the dossier folder is a link")
        folder.mkdir(parents=True, exist_ok=True)
        if dossier["sbom"] is not None:
            (folder / SBOM_FILE).write_text(
                json.dumps(dossier["sbom"], indent=2), encoding="utf-8"
            )
        (folder / DOSSIER_FILE).write_text(
            json.dumps(dossier, indent=2), encoding="utf-8"
        )
        (folder / MARKDOWN_FILE).write_text(dossier_markdown(dossier), encoding="utf-8")
    except (OSError, ValueError) as exc:
        logger.warning("[provenance] dossier not written: %s", exc)
        return None
    return dossier

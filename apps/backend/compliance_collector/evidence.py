"""Dated audit evidence, read from what the project and its tasks already left (#357).

Nothing is asked of anyone: every item comes from a file a feature wrote or
from git, each with its date, so that a report can tell a control met this
month from one last met a year ago.

- **The tasks** (`.workpilot/specs/*/`): who approved the spec and when
  (`review_state.json`), the QA reviewer's sign-off (`implementation_plan.json`),
  the tests the build ran (`hard_gates.json`, `verify/verify.json`,
  `mutation_gate.json`), the security checks (`dependency_guard.json`,
  `red_team.json`, `security_scan_results.json`) and the provenance dossier.
- **git**: the commits (changes), the merges of reviewed pull requests, the
  release tags.
- **The configuration in place**, for every stack and CI: code owners, policy
  and procedure documents, scanners, monitoring, deployment pipelines; dated
  by their last commit (their file date without git).
- **Incidents**: `.workpilot/incidents/*.json|md`, `docs/incidents/`,
  `docs/postmortems/`.

An item holds names, dates, verdicts and paths, never code or a secret. What
WorkPilot cannot see on a desktop (SSO logins, role changes, deployments run
outside the repository) is reported as a gap by the controls that need it.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

__all__ = ["Evidence", "collect_evidence", "STATIC_PATTERNS", "SPEC_RECORDS"]

DAY = 86_400
MAX_COMMITS = 5000
MAX_SPECS = 500
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_WALK = 50_000
_SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
    "bin", "obj", "target", "vendor", ".next", ".nuxt", "Pods", ".gradle",
    ".dart_tool", ".idea", ".vs", ".workpilot",
}  # fmt: skip
_CONFIG_DIRS = {
    ".github",
    ".gitlab",
    ".circleci",
    ".azure-pipelines",
    ".semgrep",
    ".bitbucket",
}

#: The records of a task, by the module that writes each (a test holds them equal).
SPEC_RECORDS = {
    "review_state": "review_state.json",  # review/state.py
    "plan": "implementation_plan.json",  # qa/criteria.py
    "hard_gates": "hard_gates.json",  # workflows/hard_gates.py
    "verify": "verify/verify.json",  # verify/record.py
    "mutation": "mutation_gate.json",  # mutation_gate/
    "dependency_guard": "dependency_guard.json",  # dependency_guard/guard.py
    "red_team": "red_team.json",  # red_team/
    "security_scan": "security_scan_results.json",  # qa security scanner
    "dossier": "provenance/dossier.json",  # provenance/dossier.py
}

#: The configuration that evidences a standing control, by kind (fnmatch on
#: the path relative to the root, lower-cased).
STATIC_PATTERNS: dict[str, tuple[str, ...]] = {
    "access": (
        "codeowners", ".github/codeowners", "docs/codeowners", ".gitlab/codeowners",
        ".bitbucket/codeowners", "owners", "*/owners", ".github/settings.yml",
        "docs/access*.md",
    ),
    "policy": (
        "security.md", ".github/security.md", "docs/security.md", "privacy.md",
        "docs/policies/*", "docs/policy/*", "docs/security/*", "policies/*",
        "docs/compliance/*",
    ),
    "procedure": (
        "incident_response*.md", "incident-response*.md", "docs/incident-response*",
        "docs/incident_response*", "docs/runbooks/*", "runbooks/*", "docs/runbook*",
        "docs/disaster-recovery*", "docs/business-continuity*", "docs/bcp*",
        "docs/drp*",
    ),
    "security_config": (
        ".github/dependabot.yml", ".github/dependabot.yaml", "renovate.json",
        "renovate.json5", ".renovaterc", ".renovaterc.json", ".github/renovate.json",
        ".snyk", "trivy*.yaml", ".trivyignore", "*.semgrep.yml", ".semgrep.yml",
        ".semgrep/*", ".github/workflows/codeql*", ".github/workflows/*security*",
        "sonar-project.properties", ".gitleaks.toml", "osv-scanner.toml",
        ".github/workflows/*scorecard*", ".gitlab/security*", "dependency-check*",
    ),
    "monitoring": (
        "prometheus*.yml", "prometheus*.yaml", "*/prometheus*.yml", "*/prometheus*.yaml",
        "alertmanager*.yml", "alertmanager*.yaml", "*/alertmanager*.y*ml",
        "*.rules.yml", "*alerts*.yml", "*alerts*.yaml", "sentry.properties",
        ".sentryclirc", "sentry.*.config.*", "otel-collector*.y*ml",
        "*/otel-collector*.y*ml", "opentelemetry*.y*ml", "datadog.yaml",
        "newrelic.js", "newrelic.yml", "newrelic.ini", "grafana/*", "*/grafana/*",
        "serilog*.json", "log4j2*.xml", "logback*.xml", "nlog.config",
    ),
    "deployment": (
        ".github/workflows/deploy*", ".github/workflows/release*",
        ".github/workflows/cd*", ".gitlab-ci.yml", "azure-pipelines.yml",
        ".azure-pipelines/*", "bitbucket-pipelines.yml", "jenkinsfile",
        ".circleci/config.yml", "dockerfile", "*/dockerfile", "docker-compose*.y*ml",
        "compose*.y*ml", "chart.yaml", "*/chart.yaml", "fly.toml", "vercel.json",
        "netlify.toml", "app.yaml", "procfile", "serverless.yml", "skaffold.yaml",
        "*.tf", "*/*.tf", "cloudbuild.yaml", "buildspec.yml", "appveyor.yml",
        ".drone.yml", ".woodpecker.yml", "codemagic.yaml", "fastlane/fastfile",
        "eas.json",
    ),
    "incident": (
        "docs/incidents/*", "docs/postmortems/*", "docs/post-mortems/*",
        "postmortems/*", "incidents/*",
    ),
}  # fmt: skip

#: Per kind, the most files read as evidence (the rest are counted).
MAX_PER_KIND = 40


@dataclass(frozen=True)
class Evidence:
    kind: str
    at: float
    """When it happened (epoch seconds, UTC)."""
    title: str
    source: str
    """Where an auditor finds it: a path, a commit, a tag."""
    outcome: str = "info"
    """``pass``, ``fail`` or ``info`` (a fact, neither)."""
    actor: str = ""
    task: str = ""

    def to_dict(self) -> dict[str, Any]:
        out = asdict(self)
        out["at"] = datetime.fromtimestamp(self.at, tz=UTC).isoformat(
            timespec="seconds"
        )
        return {k: v for k, v in out.items() if v != ""}


def _when(value: Any) -> float | None:
    """Epoch seconds from a number or an ISO 8601 string."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value) if 0 < value < 32503680000 else None
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.timestamp()


def _read_json(path: Path) -> dict | None:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_RECORD_BYTES:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def _short(value: Any, limit: int = 160) -> str:
    return str(value or "").replace("\n", " ").strip()[:limit]


# -- the tasks -----------------------------------------------------------------


def _spec_dirs(root: Path) -> list[Path]:
    specs = root / ".workpilot" / "specs"
    if not specs.is_dir() or specs.is_symlink() or specs.parent.is_symlink():
        return []
    try:
        found = [p for p in specs.iterdir() if p.is_dir() and not p.is_symlink()]
    except OSError:
        return []
    return sorted(found, key=_mtime, reverse=True)[:MAX_SPECS]


def _record(spec: Path, key: str) -> tuple[dict | None, Path]:
    path = spec / SPEC_RECORDS[key]
    if path.parent != spec and path.parent.is_symlink():
        return None, path
    return _read_json(path), path


def _status_outcome(status: Any, passing=("pass", "none"), failing=("fail",)) -> str:
    if status in passing:
        return "pass"
    if status in failing:
        return "fail"
    return "info"


def _task_evidence(spec: Path) -> list[Evidence]:
    task = spec.name
    found: list[Evidence] = []

    def add(kind, at, title, source, outcome="info", actor=""):
        if at:
            found.append(
                Evidence(
                    kind, at, _short(title), source, outcome, _short(actor, 80), task
                )
            )

    rel = f".workpilot/specs/{task}"
    state, path = _record(spec, "review_state")
    if state and state.get("approved") is True:
        add(
            "spec_approval",
            _when(state.get("approved_at")) or _mtime(path),
            "Spec approved",
            f"{rel}/{SPEC_RECORDS['review_state']}",
            "pass",
            state.get("approved_by"),
        )

    plan, path = _record(spec, "plan")
    signoff = (plan or {}).get("qa_signoff")
    if isinstance(signoff, dict) and signoff.get("status") in ("approved", "rejected"):
        approved = signoff["status"] == "approved"
        issues = signoff.get("issues_found")
        add(
            "code_review",
            _when(signoff.get("timestamp")) or _mtime(path),
            "QA review approved"
            if approved
            else f"QA review rejected ({len(issues) if isinstance(issues, list) else 0} issue(s))",
            f"{rel}/{SPEC_RECORDS['plan']}",
            "pass" if approved else "fail",
            "qa_reviewer",
        )

    gates, path = _record(spec, "hard_gates")
    for result in (gates or {}).get("results") or []:
        if not isinstance(result, dict):
            continue
        gate = _short(result.get("gate"), 60)
        if not gate.startswith("tests-"):
            continue
        held = result.get("held")
        add(
            "tests",
            _when(gates.get("at")) or _mtime(path),
            f"Gate {gate}: " + {True: "held", False: "failed"}.get(held, "unknown"),
            f"{rel}/{SPEC_RECORDS['hard_gates']}",
            {True: "pass", False: "fail"}.get(held, "info"),
        )

    verify, path = _record(spec, "verify")
    if verify and verify.get("status") in ("pass", "fail"):
        add(
            "tests",
            _when(verify.get("finished_at")) or _mtime(path),
            f"App verification: {verify['status']}"
            + (
                f", score {verify['score']}"
                if isinstance(verify.get("score"), int | float)
                else ""
            ),
            f"{rel}/{SPEC_RECORDS['verify']}",
            _status_outcome(verify["status"], passing=("pass",)),
        )

    mutation, path = _record(spec, "mutation")
    if mutation and mutation.get("status") in ("pass", "fail"):
        score = mutation.get("score")
        add(
            "tests",
            _when(mutation.get("finished_at") or mutation.get("at")) or _mtime(path),
            f"Mutation testing: {mutation['status']}"
            + (f", score {score}%" if isinstance(score, int | float) else ""),
            f"{rel}/{SPEC_RECORDS['mutation']}",
            _status_outcome(mutation["status"], passing=("pass",)),
        )

    guard, path = _record(spec, "dependency_guard")
    if guard and guard.get("status") in ("pass", "blocked"):
        add(
            "security",
            _when(guard.get("checked_at")) or _mtime(path),
            f"Dependency guard: {guard['status']}",
            f"{rel}/{SPEC_RECORDS['dependency_guard']}",
            _status_outcome(guard["status"], failing=("blocked",)),
        )

    red, path = _record(spec, "red_team")
    if red and red.get("status") in ("pass", "fail", "none"):
        add(
            "security",
            _when(red.get("finished_at")) or _mtime(path),
            f"Red team: {red['status']}",
            f"{rel}/{SPEC_RECORDS['red_team']}",
            _status_outcome(red["status"]),
        )

    scan, path = _record(spec, "security_scan")
    if scan is not None:
        blocking = scan.get("has_critical_issues") or scan.get("should_block_qa")
        add(
            "security",
            _when(scan.get("timestamp") or scan.get("scanned_at")) or _mtime(path),
            "Security scan" + (": critical issue found" if blocking else ""),
            f"{rel}/{SPEC_RECORDS['security_scan']}",
            "fail" if blocking else "pass",
        )

    dossier, path = _record(spec, "dossier")
    if dossier is not None:
        add(
            "change",
            _when(dossier.get("generated_at")) or _mtime(path),
            f"Provenance dossier: {dossier.get('changed_files', 0)} file(s) changed",
            f"{rel}/{SPEC_RECORDS['dossier']}",
        )
    return found


# -- git -----------------------------------------------------------------------

_PR_SQUASH = re.compile(r"\(#\d+\)\s*$")
_PR_MERGE = re.compile(
    r"^Merge (pull request|branch .+ into )|^Merged in |^Merge .*!\d+"
)


def _git(root: Path, *args: str) -> str | None:
    try:
        out = run_git(list(args), cwd=root, timeout=60)
    except (OSError, ValueError):
        return None
    return out.stdout if out.returncode == 0 else None


def _is_git(root: Path) -> bool:
    inside = _git(root, "rev-parse", "--is-inside-work-tree")
    return bool(inside and inside.strip() == "true")


def _git_evidence(root: Path, since: float, until: float) -> list[Evidence]:
    found: list[Evidence] = []
    log = _git(
        root,
        "log",
        f"--since=@{int(since)}",
        f"--until=@{int(until)}",
        f"--max-count={MAX_COMMITS}",
        "--format=%H%x1f%ct%x1f%an%x1f%P%x1f%s",
    )
    for line in (log or "").splitlines():
        parts = line.split("\x1f")
        if len(parts) != 5 or not parts[1].isdigit():
            continue
        sha, at, author, parents, subject = parts
        merged = len(parents.split()) > 1 or _PR_SQUASH.search(subject)
        if merged or _PR_MERGE.search(subject):
            found.append(
                Evidence(
                    "merge",
                    float(at),
                    _short(subject),
                    f"commit {sha[:12]}",
                    "pass",
                    _short(author, 80),
                )
            )
        else:
            found.append(
                Evidence(
                    "change",
                    float(at),
                    _short(subject),
                    f"commit {sha[:12]}",
                    "info",
                    _short(author, 80),
                )
            )
    tags = _git(
        root,
        "for-each-ref",
        "refs/tags",
        "--format=%(refname:short)%1f%(creatordate:unix)",
    )
    for line in (tags or "").splitlines():
        name, _, at = line.partition("\x1f")
        if at.isdigit() and since <= int(at) <= until:
            found.append(
                Evidence(
                    "release",
                    float(at),
                    f"Release {_short(name, 80)}",
                    f"tag {_short(name, 80)}",
                )
            )
    return found


# -- the configuration in place -----------------------------------------------


def _files(root: Path, use_git: bool) -> list[str]:
    if use_git:
        listed = _git(root, "ls-files", "-z")
        if listed is not None:
            return [f for f in listed.split("\0") if f]
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            d
            for d in dirnames
            if d in _CONFIG_DIRS or not (d in _SKIP_DIRS or d.startswith("."))
        ]
        base = Path(dirpath).relative_to(root).as_posix()
        for name in filenames:
            found.append(name if base == "." else f"{base}/{name}")
            if len(found) >= MAX_WALK:
                return found
    return found


def _kind_of(path: str) -> str | None:
    lowered = path.lower()
    for kind, patterns in STATIC_PATTERNS.items():
        if any(fnmatch(lowered, p) for p in patterns):
            return kind
    return None


def _last_commit(root: Path, paths: list[str]) -> dict[str, float]:
    """The date of the last commit of each path, in one walk of the history."""
    wanted = set(paths)
    dates: dict[str, float] = {}
    log = _git(
        root, "log", f"--max-count={MAX_COMMITS}", "--format=%x1e%ct", "--name-only",
        "--no-renames", "--", *paths,
    )  # fmt: skip
    for block in (log or "").split("\x1e"):
        lines = [x for x in block.splitlines() if x.strip()]
        if not lines or not lines[0].isdigit():
            continue
        for name in lines[1:]:
            if name in wanted and name not in dates:
                dates[name] = float(lines[0])
    return dates


def _incident_records(root: Path) -> list[Evidence]:
    folder = root / ".workpilot" / "incidents"
    if not folder.is_dir() or folder.is_symlink() or folder.parent.is_symlink():
        return []
    found: list[Evidence] = []
    for path in sorted(folder.iterdir())[:200]:
        if path.is_symlink() or not path.is_file():
            continue
        rel = f".workpilot/incidents/{path.name}"
        if path.suffix == ".json":
            record = _read_json(path) or {}
            at = _when(record.get("detected_at") or record.get("at")) or _mtime(path)
            resolved = _when(record.get("resolved_at"))
            title = _short(record.get("title") or path.stem)
            if resolved and resolved >= at:
                title += f" (resolved in {round((resolved - at) / 3600, 1)} h)"
            found.append(
                Evidence("incident", at, title, rel, "pass" if resolved else "info")
            )
        elif path.suffix in (".md", ".txt"):
            found.append(Evidence("incident", _mtime(path), path.stem, rel))
    return found


def _static_evidence(root: Path, use_git: bool) -> list[Evidence]:
    by_kind: dict[str, list[str]] = {}
    for rel in _files(root, use_git):
        kind = _kind_of(rel)
        if kind:
            by_kind.setdefault(kind, []).append(rel)
    picked = {kind: sorted(paths)[:MAX_PER_KIND] for kind, paths in by_kind.items()}
    every = [p for paths in picked.values() for p in paths]
    dates = _last_commit(root, every) if use_git and every else {}
    found: list[Evidence] = []
    for kind, paths in picked.items():
        for rel in paths:
            path = root / rel
            if path.is_symlink():
                continue
            at = dates.get(rel) or _mtime(path)
            if at:
                found.append(Evidence(kind, at, rel, rel))
    return found


def collect_evidence(
    project_root: Path | str, since: float, until: float, *, use_git: bool = True
) -> list[Evidence]:
    """Every dated item of evidence up to ``until``; activity from ``since`` on.

    The configuration in place and the tasks' records are read whatever their
    date (a policy written two years ago is still a policy, and a stale one);
    the git history only between the two."""
    root = Path(project_root)
    git = use_git and _is_git(root)
    found: list[Evidence] = []
    for spec in _spec_dirs(root):
        found.extend(_task_evidence(spec))
    if git:
        found.extend(_git_evidence(root, since, until))
    found.extend(_static_evidence(root, git))
    found.extend(_incident_records(root))
    return sorted((e for e in found if e.at <= until), key=lambda e: e.at, reverse=True)

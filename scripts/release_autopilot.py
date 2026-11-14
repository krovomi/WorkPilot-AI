#!/usr/bin/env python3
"""Release autopilot: publish develop to main as a new version, on its own.

Each release used to take a person, or a thread, four steps: a release-prep
pull request on ``develop`` (version bump, changelog fragments folded), a
``develop -> main`` pull request, a merge commit, then the README and wiki
follow-ups. ``prepare-release.yml`` and ``release.yml`` already do the tag, the
builds and the publication once ``main`` moves; this script, run by
``.github/workflows/release-autopilot.yml``, does the rest:

1. What is unreleased: the first-parent commits of ``develop`` that ``main``
   does not have, each with its pull request (title, labels, description).
2. Which version: the strongest change wins (semantic versioning).
   ``major`` = a ``!`` after the type (``feat!:``), a ``BREAKING CHANGE:``
   footer, ``**Breaking:** Yes`` in the template, a ``breaking`` label or a
   ``⚠️ Changement incompatible`` fragment; ``minor`` = ``feat`` or a
   ``✨ Nouveautés`` fragment; ``patch`` = ``fix``, ``perf``, ``refactor``,
   ``revert``, ``build``, ``chore(deps)`` or any other fragment. ``docs``,
   ``ci``, ``test``, ``style`` and other ``chore`` ship with the next version
   but never start one. A ``semver:major|minor|patch|none`` label overrides.
3. When: a release builds and signs four platforms, so merges are batched.
   A version starts when ``develop`` has had no merge for ``QUIET_HOURS``
   (2 h), the previous version is ``MIN_INTERVAL_HOURS`` old (24 h) and every
   push workflow of ``develop``'s head is green.
4. How: ``release/vX.Y.Z`` = ``develop`` + one commit (version in the five
   manifests, fragments folded into ``CHANGELOG.md``), a pull request into
   ``main`` labelled ``release-autopilot``, merged with a **merge commit**
   (the only method the ``main`` ruleset allows) once every check of its head
   is green. The merge starts ``prepare-release.yml`` (tag) then
   ``release.yml``. ``main`` is then merged back into ``develop``, so the
   version commit reaches ``develop`` and the next release has no conflict.
   Before the commit, Claude Code writes the version's documentation on the
   branch (README EN/FR, docs, changelog title and intro, a wiki patch):
   ``scripts/release_docs.py``. Without it the pull request carries
   ``release-autopilot/documentation`` and waits for a person.
5. A red or blocked release pull request is labelled and left for a person;
   once ``develop`` has received new merges (a fix), green and quiet, it is
   closed and prepared again from the new ``develop``.

Pushes and merges use ``PAT_TOKEN``: a push made with the default token never
starts CI, so without it nothing is written. Repository variables:
``RELEASE_AUTOPILOT=off`` stops it, ``RELEASE_AUTOPILOT_QUIET_HOURS`` and
``RELEASE_AUTOPILOT_MIN_INTERVAL_HOURS`` change the cadence.

    python scripts/release_autopilot.py            # act
    python scripts/release_autopilot.py --dry-run  # say what it would do
    python scripts/release_autopilot.py --now      # skip the cadence once
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import changelog  # noqa: E402
import release_docs  # noqa: E402
from stack_autopilot import GREEN, GitHub, checks_verdict, summary  # noqa: E402

LABEL = "release-autopilot"
RED_LABEL = "release-autopilot/rouge"
BLOCKED_LABEL = "release-autopilot/bloquee"
#: The documentation could not be written: no merge until a person removes it.
DOCS_LABEL = "release-autopilot/documentation"
BRANCH_PREFIX = "release/v"
RELEASE_BRANCH = "main"
SOURCE_BRANCH = "develop"
#: The only method the main ruleset accepts (docs/RELEASE.md).
MERGE_METHOD = "merge"
#: Subject of every commit this script writes; such commits never count as a
#: change to release, nor as activity on develop.
COMMIT_PREFIX = "chore(release): "
#: Never waited for: this workflow and the stack autopilot.
OWN_CHECKS = frozenset(
    {"Release autopilot", "release-autopilot", "Stack autopilot", "stack-autopilot"}
)
DEFAULT_QUIET_HOURS = 2.0
DEFAULT_MIN_INTERVAL_HOURS = 24.0
#: A head with no workflow at all is trusted after this long (paths-ignore).
NO_RUN_GRACE_SECONDS = 20 * 60

#: Every file that carries the app's version; all move together.
VERSION_FILES = (
    "package.json",
    "apps/frontend/package.json",
    "apps/mobile/package.json",
    "apps/mobile/app.json",
    "apps/backend/__init__.py",
)

#: What the release commit may hold besides the manifests.
DOC_PATHS = (
    "CHANGELOG.md",
    "changelog.d",
    "README.md",
    "README.fr.md",
    "docs",
    "scripts/wiki/patches",
)

LEVELS = ("none", "patch", "minor", "major")
TITLES = {
    "major": "Version majeure : changements incompatibles",
    "minor": "Nouveautés et corrections",
    "patch": "Corrections et maintenance",
}
SECTION_LEVELS = {
    "⚠️ Changement incompatible": "major",
    "✨ Nouveautés": "minor",
}
SEMVER_LABELS = {
    "semver:major": "major",
    "semver:minor": "minor",
    "semver:patch": "patch",
    "semver:none": "none",
}
BREAKING_LABELS = frozenset({"breaking", "breaking-change"})
PATCH_TYPES = frozenset({"fix", "perf", "refactor", "revert", "build", "security"})

_CONVENTIONAL = re.compile(r"^(\w{1,20})(?:\(([^)]{0,80})\))?(!)?:\s")
_BREAKING_FOOTER = re.compile(r"(?m)^BREAKING[ -]CHANGE:")
_BREAKING_TEMPLATE = re.compile(r"(?mi)^\*\*Breaking:\*\*[ \t]*(?:yes|oui)[ \t]*$")
_STABLE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.]+)?$")
_PR_IN_SUBJECT = (
    re.compile(r"\(#(\d+)\)\s*$"),
    re.compile(r"^Merge pull request #(\d+) "),
)
_TOOLING_SUBJECTS = re.compile(
    r"^docs: (?:merge the v\S+ README into develop|update README to v)"
)
_JSON_VERSION = re.compile(r'("version"\s*:\s*")[^"]*(")')
_PY_VERSION = re.compile(r'(__version__\s*=\s*")[^"]*(")')


# --------------------------------------------------------------------------
# Which version
# --------------------------------------------------------------------------


def classify(
    title: str, body: str = "", labels: frozenset[str] | set[str] = frozenset()
) -> str:
    """The semantic-versioning level one merged change asks for."""
    names = {label.lower() for label in labels}
    for label, level in SEMVER_LABELS.items():
        if label in names:
            return level
    match = _CONVENTIONAL.match(title.strip())
    if (
        (match and match.group(3))
        or _BREAKING_FOOTER.search(body or "")
        or _BREAKING_TEMPLATE.search(body or "")
        or names & BREAKING_LABELS
    ):
        return "major"
    if match:
        kind = match.group(1).lower()
        scope = (match.group(2) or "").lower()
        if kind in {"feat", "feature"}:
            return "minor"
        if kind in PATCH_TYPES:
            return "patch"
        # A dependency of the app ships in the binary; a CI one does not.
        if kind == "chore" and scope.startswith("deps"):
            return "patch"
        return "none"
    if "feature" in names:
        return "minor"
    if "bug" in names:
        return "patch"
    return "none"


def strongest(levels) -> str:
    return max(levels, key=LEVELS.index, default="none")


def fragment_levels(directory: Path = changelog.FRAGMENTS) -> list[str]:
    """One level per changelog fragment waiting in ``changelog.d/``."""
    return [
        SECTION_LEVELS.get(changelog.read_fragment(path)[0], "patch")
        for path in changelog.fragment_files(directory)
    ]


def parse_version(version: str) -> tuple[int, int, int]:
    match = _VERSION.match(version.strip())
    if not match:
        raise ValueError(f"{version!r} is not a version (X.Y.Z)")
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def bump(version: str, level: str) -> str:
    major, minor, patch = parse_version(version)
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    if level == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ValueError(f"no version for level {level!r}")


def latest_stable(tags: list[str]) -> str | None:
    """The highest ``vX.Y.Z`` tag, pre-releases (``-beta.N``) left out."""
    found = [
        tuple(int(n) for n in m.groups()) for m in map(_STABLE_TAG.match, tags) if m
    ]
    if not found:
        return None
    return ".".join(str(n) for n in max(found))


def target_version(latest_tag: str | None, package_version: str, level: str) -> str:
    """The next version; a manifest bumped by hand past it is kept."""
    computed = bump(latest_tag or package_version, level)
    if parse_version(package_version) > parse_version(computed):
        return package_version
    return computed


# --------------------------------------------------------------------------
# When
# --------------------------------------------------------------------------


@dataclass
class Change:
    sha: str
    subject: str
    date: str
    number: int | None = None
    title: str = ""
    body: str = ""
    labels: frozenset[str] = field(default_factory=frozenset)

    @property
    def tooling(self) -> bool:
        """A commit of this script or of the README sync, not a change."""
        return self.subject.startswith(COMMIT_PREFIX) or bool(
            _TOOLING_SUBJECTS.match(self.subject)
        )

    @property
    def level(self) -> str:
        return classify(self.title or self.subject, self.body, self.labels)

    @property
    def ref(self) -> str:
        return f"#{self.number}" if self.number else self.sha[:8]


def number_in_subject(subject: str) -> int | None:
    for pattern in _PR_IN_SUBJECT:
        match = pattern.search(subject)
        if match:
            return int(match.group(1))
    return None


def _hours_since(now: datetime, iso: str) -> float:
    then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (now - then).total_seconds() / 3600


@dataclass
class Plan:
    action: str  # "prepare", "wait" or "nothing"
    reason: str
    level: str = "none"


def plan_release(
    changes: list[Change],
    fragments: list[str],
    *,
    now: datetime,
    last_release: str | None,
    develop_state: str,
    quiet_hours: float = DEFAULT_QUIET_HOURS,
    min_interval_hours: float = DEFAULT_MIN_INTERVAL_HOURS,
    force: bool = False,
) -> Plan:
    real = [c for c in changes if not c.tooling]
    if not real:
        return Plan("nothing", "rien de nouveau sur develop depuis la dernière version")
    level = strongest([c.level for c in real] + fragments)
    if level == "none":
        return Plan(
            "nothing",
            f"{len(real)} changement(s) sans effet pour l'utilisateur (docs, CI, tests) : ils partiront avec la prochaine version",
        )
    if not force:
        if last_release and _hours_since(now, last_release) < min_interval_hours:
            return Plan(
                "wait",
                f"la dernière version a moins de {min_interval_hours:g} h",
                level,
            )
        latest = max(c.date for c in real)
        if _hours_since(now, latest) < quiet_hours:
            return Plan(
                "wait",
                f"develop a reçu une fusion il y a moins de {quiet_hours:g} h",
                level,
            )
    if develop_state == "pending":
        return Plan("wait", "la CI de develop tourne encore", level)
    if develop_state != "green":
        return Plan("wait", "la CI de develop est rouge", level)
    return Plan("prepare", f"{len(real)} changement(s), niveau {level}", level)


def runs_verdict(runs: list[dict], commit_age_seconds: float) -> str:
    """``green``, ``pending`` or ``red`` from the push workflow runs of a commit."""
    newest: dict[str, dict] = {}
    for run in runs:
        name = run.get("name", "")
        if name in OWN_CHECKS:
            continue
        if run.get("id", 0) >= newest.get(name, {}).get("id", 0):
            newest[name] = run
    if not newest:
        return "green" if commit_age_seconds >= NO_RUN_GRACE_SECONDS else "pending"
    if any(
        r.get("status") == "completed" and r.get("conclusion") not in GREEN
        for r in newest.values()
    ):
        return "red"
    if any(r.get("status") != "completed" for r in newest.values()):
        return "pending"
    return "green"


# --------------------------------------------------------------------------
# The release commit
# --------------------------------------------------------------------------


def write_versions(root: Path, version: str) -> None:
    """Set ``version`` in every manifest, keeping indentation and line endings."""
    parse_version(version)
    for relative in VERSION_FILES:
        path = root / relative
        with open(path, encoding="utf-8", newline="") as handle:
            text = handle.read()
        pattern = _PY_VERSION if relative.endswith(".py") else _JSON_VERSION
        updated, count = pattern.subn(rf"\g<1>{version}\g<2>", text, count=1)
        if count != 1:
            raise RuntimeError(f"{relative}: no version field found")
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(updated)


def intro(changes: list[Change], previous: str | None) -> str:
    real = [c for c in changes if not c.tooling]
    refs = ", ".join(c.ref for c in sorted(real, key=lambda c: c.number or 0))
    since = f"depuis v{previous}" if previous else "depuis le début"
    return (
        f"Version publiée automatiquement depuis `develop` : {len(real)} "
        f"changement(s) fusionné(s) {since} ({refs})."
    )


def write_changelog(
    version: str,
    level: str,
    changes: list[Change],
    previous: str | None,
    directory: Path = changelog.FRAGMENTS,
    path: Path = changelog.CHANGELOG,
) -> bool:
    """Fold the fragments into ``## version``; False when it is already there."""
    text = path.read_text(encoding="utf-8")
    if re.search(rf"(?m)^## {re.escape(version)}(\s|$)", text):
        return False
    if not changelog.fragment_files(directory):
        # Nothing described (dependency bumps only): list the pull requests.
        lines = [
            f"- {(c.title or c.subject).strip()} ({c.ref})."
            for c in changes
            if not c.tooling and c.level != "none"
        ]
        (directory / "zz-release-autopilot.md").write_text(
            "---\nsection: 🧹 Maintenance\n---\n\n" + "\n".join(lines) + "\n",
            encoding="utf-8",
        )
    changelog.release(version, TITLES[level], directory, path)
    text = path.read_text(encoding="utf-8")
    path.write_text(
        text.replace(changelog.INTRO_PLACEHOLDER, intro(changes, previous), 1),
        encoding="utf-8",
        newline="\n",
    )
    return True


def section_notes(text: str, version: str) -> str:
    """The notes prepare-release.yml reads: from ``## version`` to the next ``##`` or ``---``."""
    out: list[str] = []
    found = False
    for line in text.splitlines():
        if line.startswith("## "):
            if found:
                break
            found = line.split()[1] == version
            continue
        if line == "---" and found:
            break
        if found:
            out.append(line)
    return "\n".join(out).strip()


def change_lines(changes: list[Change]) -> str:
    return "\n".join(
        f"- {c.ref} [{c.level}] {(c.title or c.subject).strip()}"
        for c in sorted(changes, key=lambda c: c.number or 0)
        if not c.tooling
    )


def pr_body(
    version: str,
    level: str,
    changes: list[Change],
    previous: str | None,
    docs: release_docs.DocsResult | None = None,
) -> str:
    real = [c for c in changes if not c.tooling]
    rows = "\n".join(
        f"| {c.ref} | {(c.title or c.subject).replace('|', '/')} | {c.level} |"
        for c in sorted(real, key=lambda c: c.number or 0)
    )
    return (
        f"Release **v{version}** ({level}), préparée par `release-autopilot.yml` "
        f"depuis `{SOURCE_BRANCH}`{f' (dernière version : v{previous})' if previous else ''}.\n\n"
        "Le niveau est le plus fort des changements ci-dessous (titre conventionnel, "
        "labels `semver:*`, fragments de `changelog.d/`). Elle est fusionnée par "
        "**commit de merge** quand tous ses checks sont verts ; la fusion crée le tag et "
        "lance `release.yml`. Pour l'arrêter : variable `RELEASE_AUTOPILOT=off`, puis "
        "fermer cette PR.\n\n"
        f"{docs_line(docs)}\n\n"
        "| PR | Titre | Niveau |\n|---|---|---|\n"
        f"{rows}\n"
    )


def docs_line(docs: release_docs.DocsResult | None) -> str:
    if docs is None:
        return "**Documentation** : non demandée."
    if docs.status == "written":
        files = ", ".join(f"`{f}`" for f in docs.files)
        return f"**Documentation** (README EN/FR, docs, wiki) mise à jour par Claude Code, à relire dans le diff : {files}."
    if docs.status == "unchanged":
        return "**Documentation** : Claude Code n'a rien trouvé à changer pour cette version."
    return (
        f"**Documentation** : ⚠️ non mise à jour ({docs.reason}). Le label `{DOCS_LABEL}` "
        "retient la fusion : écrivez-la sur cette branche (README EN/FR, docs, patch du wiki), "
        "puis retirez le label."
    )


# --------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------


def git(*args: str, cwd: Path = ROOT, check: bool = True) -> str:
    done = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8"
    )
    if check and done.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args[:2])}… failed: {done.stderr.strip()[-2000:]}"
        )
    return done.stdout.strip()


def git_ok(*args: str, cwd: Path = ROOT) -> bool:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True).returncode == 0


def merge_back(cwd: Path, version: str | None, push: bool = True) -> str:
    """Merge ``origin/main`` into ``develop`` with a merge commit.

    ``merged``, ``up-to-date`` or ``conflict`` (nothing pushed then).
    """
    git("fetch", "origin", RELEASE_BRANCH, SOURCE_BRANCH, cwd=cwd)
    remote_main = f"origin/{RELEASE_BRANCH}"
    remote_dev = f"origin/{SOURCE_BRANCH}"
    if git_ok("merge-base", "--is-ancestor", remote_main, remote_dev, cwd=cwd):
        return "up-to-date"
    what = f"v{version}" if version else RELEASE_BRANCH
    for attempt in range(3):
        if attempt:
            git("fetch", "origin", RELEASE_BRANCH, SOURCE_BRANCH, cwd=cwd)
        git("checkout", "-q", "-B", SOURCE_BRANCH, remote_dev, cwd=cwd)
        if not git_ok(
            "merge",
            "--no-ff",
            "-m",
            f"{COMMIT_PREFIX}merge {what} back into develop",
            remote_main,
            cwd=cwd,
        ):
            git("merge", "--abort", cwd=cwd, check=False)
            return "conflict"
        if not push or git_ok(
            "push", "origin", f"HEAD:refs/heads/{SOURCE_BRANCH}", cwd=cwd
        ):
            return "merged"
    raise RuntimeError("develop kept moving: main not merged back, next run retries")


class ReleaseGitHub(GitHub):
    def create(self, path: str, fields: dict[str, str]) -> dict:
        if self.dry_run:
            print(f"  [dry-run] POST {path} {fields}")
            return {"number": 0, "html_url": "(dry-run)"}
        args = ["api", "-X", "POST", path]
        for name, value in fields.items():
            args += ["-f", f"{name}={value}"]
        return json.loads(self._gh(args, write=True) or "{}")


@dataclass
class ReleasePR:
    number: int
    head_ref: str
    head_sha: str
    labels: set[str]

    @property
    def version(self) -> str:
        return self.head_ref[len(BRANCH_PREFIX) :]


class ReleaseAutopilot:
    def __init__(
        self,
        gh: ReleaseGitHub,
        *,
        can_push: bool,
        quiet_hours: float,
        min_interval_hours: float,
        force: bool,
        cwd: Path = ROOT,
    ):
        self.gh = gh
        self.can_push = can_push
        self.quiet_hours = quiet_hours
        self.min_interval_hours = min_interval_hours
        self.force = force
        self.cwd = cwd
        self.now = datetime.now(UTC)

    # -- reading -----------------------------------------------------------

    def open_release_prs(self) -> list[ReleasePR]:
        raw = self.gh.pages(
            f"repos/{self.gh.repo}/pulls?state=open&base={RELEASE_BRANCH}&per_page=100"
        )
        return [
            ReleasePR(
                number=pr["number"],
                head_ref=pr["head"]["ref"],
                head_sha=pr["head"]["sha"],
                labels={label["name"] for label in pr.get("labels", [])},
            )
            for pr in raw
            if LABEL in {label["name"] for label in pr.get("labels", [])}
            and pr["head"]["ref"].startswith(BRANCH_PREFIX)
            and (pr["head"].get("repo") or {}).get("full_name") == self.gh.repo
        ]

    def changes(self, since: str) -> list[Change]:
        log = git(
            "log",
            "--first-parent",
            "--format=%H%x1f%s%x1f%cI",
            f"{since}..origin/{SOURCE_BRANCH}",
            cwd=self.cwd,
        )
        found: list[Change] = []
        for line in filter(None, log.splitlines()):
            sha, subject, date = line.split("\x1f")
            change = Change(sha=sha, subject=subject, date=date)
            if not change.tooling:
                self.describe(change)
            found.append(change)
        return found

    def describe(self, change: Change) -> None:
        pulls = self.gh.get(f"repos/{self.gh.repo}/commits/{change.sha}/pulls") or []
        wanted = number_in_subject(change.subject)
        pick = next(
            (p for p in pulls if p.get("merge_commit_sha") == change.sha),
            next((p for p in pulls if p.get("number") == wanted), None),
        )
        if pick is None and wanted:
            pick = self.gh.get(f"repos/{self.gh.repo}/pulls/{wanted}")
        if isinstance(pick, dict) and pick.get("number"):
            change.number = pick["number"]
            change.title = pick.get("title") or ""
            change.body = pick.get("body") or ""
            change.labels = frozenset(label["name"] for label in pick.get("labels", []))

    def tags(self) -> list[str]:
        return git("tag", "-l", "v*", cwd=self.cwd).splitlines()

    def tag_date(self, version: str) -> str | None:
        date = git(
            "log", "-1", "--format=%cI", f"v{version}", cwd=self.cwd, check=False
        )
        return date or None

    def develop_state(self) -> str:
        sha = git("rev-parse", f"origin/{SOURCE_BRANCH}", cwd=self.cwd)
        runs = self.gh.pages(
            f"repos/{self.gh.repo}/actions/runs?head_sha={sha}&event=push&per_page=100",
            "workflow_runs",
        )
        date = git("log", "-1", "--format=%cI", sha, cwd=self.cwd)
        age = (self.now - datetime.fromisoformat(date)).total_seconds()
        return runs_verdict(runs, age)

    def pr_state(self, pr: ReleasePR) -> str:
        runs = [
            run
            for run in self.gh.pages(
                f"repos/{self.gh.repo}/commits/{pr.head_sha}/check-runs?per_page=100",
                "check_runs",
            )
            if run.get("name") not in OWN_CHECKS
        ]
        statuses = self.gh.pages(
            f"repos/{self.gh.repo}/commits/{pr.head_sha}/statuses?per_page=100"
        )
        date = git("log", "-1", "--format=%cI", pr.head_sha, cwd=self.cwd, check=False)
        age = (self.now - datetime.fromisoformat(date)).total_seconds() if date else 0.0
        return checks_verdict(runs, statuses, age)

    def mergeable_state(self, pr: ReleasePR) -> str:
        for _ in range(6):
            raw = self.gh.get(f"repos/{self.gh.repo}/pulls/{pr.number}") or {}
            state = (
                raw.get("mergeable_state", "unknown")
                if isinstance(raw, dict)
                else "unknown"
            )
            if state != "unknown":
                return state
            time.sleep(5)
        return "unknown"

    # -- acting ------------------------------------------------------------

    def flag(self, pr: ReleasePR, label: str, why: str) -> None:
        """Label once and say why once; later runs stay quiet."""
        summary(f"- #{pr.number} (v{pr.version}) : {why}")
        if label in pr.labels:
            return
        self.gh.add_labels(pr.number, [label])
        pr.labels.add(label)
        self.gh.comment(
            pr.number,
            f"Release autopilot : {why}. Rien n'est fusionné tant que ce n'est pas "
            "réglé. Une correction fusionnée dans `develop` fait préparer cette "
            "version de nouveau, une fois `develop` vert et calme.",
        )

    def advance(self, pr: ReleasePR) -> bool:
        """Merge a green release pull request; True when it was replaced."""
        if DOCS_LABEL in pr.labels:
            summary(
                f"- #{pr.number} (v{pr.version}) : documentation à écrire ; retirez le label `{DOCS_LABEL}` une fois faite."
            )
            return False
        state = self.pr_state(pr)
        if state == "pending":
            summary(f"- #{pr.number} (v{pr.version}) : CI en cours.")
            return False
        if state == "green":
            detail = self.mergeable_state(pr)
            if detail in {"clean", "unstable", "has_hooks"}:
                self.merge(pr)
                return False
            reasons = {
                "blocked": "GitHub refuse la fusion (fil de revue non résolu, par exemple une alerte CodeQL, ou approbation demandée)",
                "dirty": "conflit avec main",
                "behind": "main a avancé",
            }
            self.flag(pr, BLOCKED_LABEL, reasons.get(detail, f"GitHub dit `{detail}`"))
        else:
            self.flag(pr, RED_LABEL, "un check est rouge sur la PR de release")
        return self.replace_if_stale(pr)

    def merge(self, pr: ReleasePR) -> None:
        self.gh.write(
            "PUT",
            f"repos/{self.gh.repo}/pulls/{pr.number}/merge",
            {
                "merge_method": MERGE_METHOD,
                "sha": pr.head_sha,
                "commit_title": f"Release v{pr.version} (#{pr.number})",
            },
        )
        summary(f"- #{pr.number} fusionnée dans main : v{pr.version} part en release.")
        if self.gh.dry_run:
            return
        result = merge_back(self.cwd, pr.version)
        if result == "conflict":
            summary(
                "> ⚠️ main n'a pas pu être fusionnée dans develop (conflit) : à faire à la main avant la prochaine version."
            )
        self.gh.write("DELETE", f"repos/{self.gh.repo}/git/refs/heads/{pr.head_ref}")

    def replace_if_stale(self, pr: ReleasePR) -> bool:
        """Close a stuck release once develop has moved on, green and quiet."""
        parent = git("rev-parse", f"{pr.head_sha}^", cwd=self.cwd, check=False)
        if not parent:
            return False
        newer = [c for c in self.changes(parent) if not c.tooling]
        if not newer:
            return False
        latest = max(c.date for c in newer)
        if not self.force and _hours_since(self.now, latest) < self.quiet_hours:
            summary(f"- #{pr.number} sera remplacée quand develop sera calme.")
            return False
        if self.develop_state() != "green":
            summary(f"- #{pr.number} sera remplacée quand la CI de develop sera verte.")
            return False
        self.gh.comment(
            pr.number,
            f"Release autopilot : `develop` a reçu {len(newer)} changement(s) depuis "
            "cette préparation ; elle est remplacée par une nouvelle PR de release.",
        )
        self.gh.write(
            "PATCH", f"repos/{self.gh.repo}/pulls/{pr.number}", {"state": "closed"}
        )
        self.gh.write("DELETE", f"repos/{self.gh.repo}/git/refs/heads/{pr.head_ref}")
        summary(f"- #{pr.number} fermée : préparée de nouveau depuis develop.")
        return True

    def prepare(self, level: str, changes: list[Change], previous: str | None) -> None:
        package = json.loads(
            (self.cwd / "apps/frontend/package.json").read_text(encoding="utf-8")
        )
        version = target_version(previous, package["version"], level)
        if f"v{version}" in self.tags():
            summary(f"> Le tag v{version} existe déjà : rien préparé.")
            return
        branch = f"{BRANCH_PREFIX}{version}"
        git("checkout", "-q", "-B", branch, f"origin/{SOURCE_BRANCH}", cwd=self.cwd)
        if package["version"] != version:
            write_versions(self.cwd, version)
        write_changelog(
            version,
            level,
            changes,
            previous,
            self.cwd / "changelog.d",
            self.cwd / "CHANGELOG.md",
        )
        docs = (
            release_docs.DocsResult("skipped", "dry-run")
            if self.gh.dry_run
            else release_docs.document(
                repo=self.gh.repo,
                cwd=self.cwd,
                version=version,
                level=level,
                previous=previous,
                notes=section_notes(
                    (self.cwd / "CHANGELOG.md").read_text(encoding="utf-8"), version
                ),
                changes=change_lines(changes),
                date=self.now.strftime("%Y-%m-%d"),
            )
        )
        summary(f"- Documentation : {docs.status} {docs.reason}".rstrip())
        git("add", "-A", "--", *VERSION_FILES, *DOC_PATHS, cwd=self.cwd)
        git(
            "commit",
            "-q",
            "-m",
            f"{COMMIT_PREFIX}{version}",
            "-m",
            intro(changes, previous),
            cwd=self.cwd,
        )
        if self.gh.dry_run:
            summary(f"- [dry-run] {branch} prêt localement (v{version}, {level}).")
            return
        git("push", "--force", "origin", f"HEAD:refs/heads/{branch}", cwd=self.cwd)
        pr = self.gh.create(
            f"repos/{self.gh.repo}/pulls",
            {
                "title": f"Release v{version}",
                "head": branch,
                "base": RELEASE_BRANCH,
                "body": pr_body(version, level, changes, previous, docs),
            },
        )
        labels = (
            [LABEL] if docs.status in {"written", "unchanged"} else [LABEL, DOCS_LABEL]
        )
        self.gh.add_labels(pr["number"], labels)
        summary(
            f"- PR de release #{pr['number']} ouverte : v{version} ({level}). {pr.get('html_url', '')}"
        )

    # -- the run -----------------------------------------------------------

    def run(self) -> int:
        summary("## Release autopilot")
        open_prs = self.open_release_prs()
        replaced = False
        if open_prs:
            for pr in open_prs:
                replaced = self.advance(pr) or replaced
            if not replaced:
                return 0
        if not self.can_push:
            summary(
                "> `PAT_TOKEN` absent : rien n'est préparé (un push du jeton par défaut ne lance pas la CI)."
            )
            return 0
        previous = latest_stable(self.tags())
        changes = self.changes(f"origin/{RELEASE_BRANCH}")
        plan = plan_release(
            changes,
            fragment_levels(self.cwd / "changelog.d"),
            now=self.now,
            last_release=self.tag_date(previous) if previous else None,
            develop_state=self.develop_state(),
            quiet_hours=self.quiet_hours,
            min_interval_hours=self.min_interval_hours,
            force=self.force or replaced,
        )
        summary(f"- {plan.action} : {plan.reason}.")
        if plan.action != "prepare":
            return 0
        # The previous release (and its README) must be in develop first, or
        # the release pull request conflicts on the version and the changelog.
        if not self.gh.dry_run and merge_back(self.cwd, None) == "merged":
            summary(
                "- main fusionnée dans develop ; la version sera préparée au prochain passage, CI verte."
            )
            return 0
        self.prepare(plan.level, changes, previous)
        return 0


def _hours(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        summary(
            f"> `{name}={raw}` n'est pas un nombre d'heures : {default:g} h retenues."
        )
        return default


def identity(gh: ReleaseGitHub) -> tuple[str, str]:
    """The PAT owner's noreply identity, so release commits are attributed."""
    try:
        user = json.loads(gh._gh(["api", "user"], write=True) or "{}")
        return user["login"], f"{user['id']}+{user['login']}@users.noreply.github.com"
    except (RuntimeError, KeyError, ValueError):
        return "WorkPilot Release Autopilot", "noreply@workpilot.ai"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--repo", default=os.environ.get("GITHUB_REPOSITORY", "krovomi/WorkPilot-AI")
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--now", action="store_true", help="skip the cadence once")
    args = parser.parse_args(argv)
    if os.environ.get("RELEASE_AUTOPILOT", "").strip().lower() == "off":
        summary("> `RELEASE_AUTOPILOT=off` : rien fait.")
        return 0
    read_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", "")
    write_token = os.environ.get("PAT_TOKEN") or None
    gh = ReleaseGitHub(args.repo, read_token, write_token, args.dry_run)
    if write_token and not args.dry_run:
        name, email = identity(gh)
        git("config", "user.name", name)
        git("config", "user.email", email)
    return ReleaseAutopilot(
        gh,
        can_push=write_token is not None or args.dry_run,
        quiet_hours=_hours("RELEASE_AUTOPILOT_QUIET_HOURS", DEFAULT_QUIET_HOURS),
        min_interval_hours=_hours(
            "RELEASE_AUTOPILOT_MIN_INTERVAL_HOURS", DEFAULT_MIN_INTERVAL_HOURS
        ),
        force=args.now,
    ).run()


if __name__ == "__main__":
    sys.exit(main())

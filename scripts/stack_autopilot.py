#!/usr/bin/env python3
"""Stack autopilot: merge the opted-in pull requests into develop, in stack order.

Threads often open a pile of pull requests where each one is built on the
previous one (#771, then #774 built on it, then #775…). GitHub's auto-merge
does not help there: it never resolves a conflict, it knows nothing of the
order, and on ``develop`` (no required check in the ruleset) it merges a pull
request the moment it stops conflicting, before CI has run on the result.

This script, run by ``.github/workflows/stack-autopilot.yml``, does it instead:

1. Opt-in: every open pull request with auto-merge enabled or the
   ``autopilot`` label. Native auto-merge is switched off and replaced by the
   labels ``autopilot`` + ``autopilot:<method>`` (the method the person chose),
   so GitHub can no longer merge it before CI.
2. Order: B waits for A when B is based on A's branch, when B's description
   names A ("built on #A", "Merge order: #A, …", "basée sur #A"), or when the
   two share commits that are not on develop (the older one goes first).
3. For each pull request with nothing ahead of it: merge develop into it. A
   parent that was squash-merged is absorbed without conflict (its squash
   commit is recorded with ``-s ours`` once the develop it was squashed onto
   is in). A remaining conflict goes to Claude Code when a token is set; a
   generated audit card is rebuilt. The result is pushed with ``PAT_TOKEN``
   so CI runs on it.
4. Once every check of the head commit is green and GitHub says the pull
   request is clean, it is merged with its method. One merge per run: the
   push to develop starts the next run, which syncs the next one in line.

A conflict that cannot be resolved, or a red CI, labels the pull request
(``autopilot/conflit``, ``autopilot/rouge``) and stops that pile there.

    python scripts/stack_autopilot.py            # act
    python scripts/stack_autopilot.py --dry-run  # say what it would do
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

OPT_IN_LABEL = "autopilot"
METHOD_PREFIX = "autopilot:"
CONFLICT_LABEL = "autopilot/conflit"
RED_LABEL = "autopilot/rouge"
METHODS = ("squash", "merge", "rebase")
#: Leub's rule for develop when nothing else was chosen.
DEFAULT_METHOD = "squash"
#: Check runs of the autopilot itself, never waited for.
OWN_CHECKS = frozenset({"Stack autopilot", "stack-autopilot"})
GREEN = frozenset({"success", "neutral", "skipped"})
#: A head commit with no check at all is waited for this long, then trusted
#: (a docs-only change can skip every workflow through paths-ignore).
NO_CHECK_GRACE_SECONDS = 20 * 60
MARKER = re.compile(r"^(<{7}|>{7})( |$)", re.M)
GENERATED_CARD = re.compile(r"^docs/audit/findings/F\d+\.js$")

_NUM = r"#(\d+)"
_HINTS = (
    re.compile(
        r"\b(?:built|stacked|based|depends|rebased)\s+(?:on|upon)\s+" + _NUM, re.I
    ),
    re.compile(
        r"\b(?:basée?|empilée?|construite?)\s+sur\s+(?:la\s+PR\s+)?" + _NUM, re.I
    ),
    re.compile(r"\bdépend\s+de\s+(?:la\s+PR\s+)?" + _NUM, re.I),
    re.compile(r"\bitself\s+on\s+" + _NUM, re.I),
)
_ORDER_LINE = re.compile(r"(?:merge order|ordre de fusion)\s*:([^\n]*)", re.I)


@dataclass
class PullRequest:
    number: int
    head_ref: str
    head_sha: str
    base_ref: str
    body: str = ""
    draft: bool = False
    labels: set[str] = field(default_factory=set)
    auto_merge_method: str | None = None

    @property
    def opted_in(self) -> bool:
        return self.auto_merge_method is not None or OPT_IN_LABEL in self.labels

    @property
    def method(self) -> str:
        for label in self.labels:
            if (
                label.startswith(METHOD_PREFIX)
                and label[len(METHOD_PREFIX) :] in METHODS
            ):
                return label[len(METHOD_PREFIX) :]
        if self.auto_merge_method in METHODS:
            return self.auto_merge_method
        return DEFAULT_METHOD


def from_api(raw: dict) -> PullRequest:
    auto = raw.get("auto_merge") or {}
    return PullRequest(
        number=raw["number"],
        head_ref=raw["head"]["ref"],
        head_sha=raw["head"]["sha"],
        base_ref=raw["base"]["ref"],
        body=raw.get("body") or "",
        draft=bool(raw.get("draft")),
        labels={label["name"] for label in raw.get("labels", [])},
        auto_merge_method=(auto.get("merge_method") or None) if auto else None,
    )


# --------------------------------------------------------------------------
# Order
# --------------------------------------------------------------------------


def hinted_parents(number: int, body: str) -> set[int]:
    """The pull requests a description says must be merged before this one."""
    found: set[int] = set()
    for pattern in _HINTS:
        found.update(int(n) for n in pattern.findall(body))
    for line in _ORDER_LINE.findall(body):
        listed = [int(n) for n in re.findall(_NUM, line)]
        if number in listed:
            listed = listed[: listed.index(number)]
        found.update(listed)
    found.discard(number)
    return found


def dependencies(
    prs: list[PullRequest],
    related: dict[frozenset[int], int | None],
) -> dict[int, set[int]]:
    """For each open pull request, the open ones that must be merged first.

    ``related`` maps a pair of pull requests sharing commits that are not on
    the base to the one that goes first (``None``: unknown, lower number first).
    """
    by_number = {pr.number: pr for pr in prs}
    by_head = {pr.head_ref: pr.number for pr in prs}
    deps: dict[int, set[int]] = {pr.number: set() for pr in prs}
    for pr in prs:
        if pr.base_ref in by_head:
            deps[pr.number].add(by_head[pr.base_ref])
        deps[pr.number].update(
            n for n in hinted_parents(pr.number, pr.body) if n in by_number
        )
    for pair, first in related.items():
        a, b = sorted(pair)
        first = first if first in pair else a
        second = b if first == a else a
        if first not in deps[second] and second not in deps[first]:
            deps[second].add(first)
    if _has_cycle(deps):
        # Contradicting hints: fall back to the order the pull requests were opened.
        deps = {n: {d for d in ds if d < n} for n, ds in deps.items()}
    return deps


def _has_cycle(deps: dict[int, set[int]]) -> bool:
    state: dict[int, int] = {}

    def visit(node: int) -> bool:
        state[node] = 1
        for nxt in deps.get(node, ()):
            if state.get(nxt) == 1 or (state.get(nxt) is None and visit(nxt)):
                return True
        state[node] = 2
        return False

    return any(state.get(n) is None and visit(n) for n in deps)


def fronts(
    prs: list[PullRequest], deps: dict[int, set[int]], base: str
) -> list[PullRequest]:
    """Pull requests with nothing open ahead of them, targeting ``base``."""
    return sorted(
        (pr for pr in prs if not deps.get(pr.number) and pr.base_ref == base),
        key=lambda pr: pr.number,
    )


# --------------------------------------------------------------------------
# Checks
# --------------------------------------------------------------------------


def checks_verdict(
    check_runs: list[dict],
    statuses: list[dict],
    commit_age_seconds: float,
) -> str:
    """``green``, ``pending`` or ``red`` for a head commit."""
    newest: dict[str, dict] = {}
    for run in check_runs:
        name = run.get("name", "")
        # A re-run adds a check run of the same name: only the newest counts.
        if name not in OWN_CHECKS and run.get("id", 0) >= newest.get(name, {}).get(
            "id", 0
        ):
            newest[name] = run
    runs = list(newest.values())
    latest: dict[str, dict] = {}
    for status in statuses:
        context = status.get("context", "")
        if context not in latest or status.get("updated_at", "") > latest[context].get(
            "updated_at", ""
        ):
            latest[context] = status
    if not runs and not latest:
        return "green" if commit_age_seconds >= NO_CHECK_GRACE_SECONDS else "pending"
    if any(
        run.get("status") == "completed" and run.get("conclusion") not in GREEN
        for run in runs
    ):
        return "red"
    if any(s.get("state") in {"failure", "error"} for s in latest.values()):
        return "red"
    if any(run.get("status") != "completed" for run in runs):
        return "pending"
    if any(s.get("state") == "pending" for s in latest.values()):
        return "pending"
    return "green"


# --------------------------------------------------------------------------
# Conflicts
# --------------------------------------------------------------------------


def split_conflicts(paths: list[str]) -> tuple[list[str], list[str]]:
    """(generated files rebuilt by a script, files that need a resolver)."""
    generated = [p for p in paths if GENERATED_CARD.match(p)]
    return generated, [p for p in paths if p not in generated]


def has_markers(text: str) -> bool:
    return bool(MARKER.search(text))


_SQUASH_SUBJECT = re.compile(r"\(#(\d+)\)\s*$")


def squash_number(subject: str) -> int | None:
    """The pull request a squash commit came from: GitHub ends its subject with (#N)."""
    match = _SQUASH_SUBJECT.search(subject.strip())
    return int(match.group(1)) if match else None


def label_is_stale(label_events: list[dict], label: str, head_date: str | None) -> bool:
    """True when the branch got a commit after the label was last put on."""
    put = [
        e.get("created_at", "")
        for e in label_events
        if e.get("event") == "labeled" and (e.get("label") or {}).get("name") == label
    ]
    return bool(put and head_date and head_date > max(put))


RESOLVE_PROMPT = """\
You are resolving a git merge conflict in the WorkPilot-AI repository, in CI.
The branch `{branch}` (pull request #{number}) is merging `{ref}`. `git status`
shows the merge in progress. Conflicted files:
{files}

Rules:
- Keep the intent of BOTH sides. `{ref}` is already merged and reviewed: never
  drop or rewrite what it brought. The branch adds its own change on top.
- Lists, tables, registries, changelog fragments, translation files: keep every
  entry from both sides, in the file's order.
- Audit findings: both sides may have created the same
  `docs/audit/findings/F<n>.md` for two different findings. Keep `{ref}`'s file
  as it is, move the branch's finding to the next free number (look at the
  files in docs/audit/findings/), then update every reference to the branch's
  finding in the lines this branch added (code comments, tests, docs,
  changelog.d), and run `python scripts/audit_findings.py build`.
- Files with a size or count ceiling (scripts/baselines/*.json): keep the
  higher of the two values only if the merged file really needs it.
- Lockfiles: keep the higher versions of both sides, valid syntax.
- Remove every conflict marker. Do not commit, do not push, do not run tests
  that need installs. Edit only what the merge needs.
"""


# --------------------------------------------------------------------------
# Plumbing (git, gh)
# --------------------------------------------------------------------------


def _run(cmd: list[str], *, check: bool = True, env: dict | None = None) -> str:
    done = subprocess.run(
        cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", env=env
    )
    if check and done.returncode != 0:
        raise RuntimeError(
            f"{' '.join(cmd[:3])}… failed: {done.stderr.strip()[-2000:]}"
        )
    return done.stdout


def git(*args: str, check: bool = True) -> str:
    return _run(["git", *args], check=check)


def git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True).returncode == 0


class GitHub:
    def __init__(
        self, repo: str, read_token: str, write_token: str | None, dry_run: bool
    ):
        self.repo = repo
        self.read_token = read_token
        self.write_token = write_token or read_token
        self.dry_run = dry_run

    def _gh(self, args: list[str], *, write: bool) -> str:
        token = self.write_token if write else self.read_token
        env = {**os.environ, "GH_TOKEN": token} if token else None
        return _run(["gh", *args], env=env)

    def get(self, path: str) -> object:
        return json.loads(self._gh(["api", path], write=False) or "null")

    def pages(self, path: str, key: str | None = None) -> list[dict]:
        out = self._gh(["api", "--paginate", "--slurp", path], write=False)
        pages = json.loads(out or "[]")
        return [item for page in pages for item in (page[key] if key else page)]

    def write(
        self, method: str, path: str, fields: dict[str, str] | None = None
    ) -> None:
        if self.dry_run:
            print(f"  [dry-run] {method} {path} {fields or ''}")
            return
        args = ["api", "-X", method, path]
        for name, value in (fields or {}).items():
            args += ["-f", f"{name}={value}"]
        self._gh(args, write=True)

    def add_labels(self, number: int, labels: list[str]) -> None:
        payload = [arg for label in labels for arg in ("-f", f"labels[]={label}")]
        if self.dry_run:
            print(f"  [dry-run] label #{number} {labels}")
            return
        self._gh(
            [
                "api",
                "-X",
                "POST",
                f"repos/{self.repo}/issues/{number}/labels",
                *payload,
            ],
            write=True,
        )

    def remove_label(self, number: int, label: str) -> None:
        self.write("DELETE", f"repos/{self.repo}/issues/{number}/labels/{label}")

    def comment(self, number: int, body: str) -> None:
        self.write(
            "POST", f"repos/{self.repo}/issues/{number}/comments", {"body": body}
        )

    def disable_auto_merge(self, number: int) -> None:
        if self.dry_run:
            print(f"  [dry-run] disable native auto-merge on #{number}")
            return
        self._gh(
            ["pr", "merge", str(number), "--disable-auto", "--repo", self.repo],
            write=True,
        )


def summary(line: str) -> None:
    print(line)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------


class Autopilot:
    def __init__(self, gh: GitHub, base: str, can_push: bool, claude: bool):
        self.gh = gh
        self.base = base
        self.can_push = can_push
        self.claude = claude
        self.remote_base = f"origin/{base}"

    # -- discovery ---------------------------------------------------------

    def open_prs(self) -> list[PullRequest]:
        raw = self.gh.pages(f"repos/{self.gh.repo}/pulls?state=open&per_page=100")
        return [pr for pr in map(from_api, raw) if pr.opted_in and not pr.draft]

    def take_over_auto_merge(self, prs: list[PullRequest]) -> None:
        """Native auto-merge would merge before CI on develop: labels replace it."""
        for pr in prs:
            if pr.auto_merge_method is None:
                continue
            wanted = [OPT_IN_LABEL, METHOD_PREFIX + pr.method]
            missing = [label for label in wanted if label not in pr.labels]
            if missing:
                self.gh.add_labels(pr.number, missing)
                pr.labels.update(missing)
            self.gh.disable_auto_merge(pr.number)
            summary(
                f"- #{pr.number}: auto-merge GitHub remplacé par `{METHOD_PREFIX}{pr.method}`."
            )

    def fetch(self, prs: list[PullRequest]) -> None:
        refs = [f"+refs/heads/{self.base}:refs/remotes/origin/{self.base}"]
        refs += [
            f"+refs/pull/{pr.number}/head:refs/autopilot/pr/{pr.number}" for pr in prs
        ]
        git("fetch", "--no-tags", "origin", *refs)

    def related_pairs(self, prs: list[PullRequest]) -> dict[frozenset[int], int | None]:
        pairs: dict[frozenset[int], int | None] = {}
        for i, a in enumerate(prs):
            for b in prs[i + 1 :]:
                shared = git("merge-base", a.head_sha, b.head_sha, check=False).strip()
                if not shared or git_ok(
                    "merge-base", "--is-ancestor", shared, self.remote_base
                ):
                    continue
                if git_ok("merge-base", "--is-ancestor", a.head_sha, b.head_sha):
                    pairs[frozenset((a.number, b.number))] = a.number
                elif git_ok("merge-base", "--is-ancestor", b.head_sha, a.head_sha):
                    pairs[frozenset((a.number, b.number))] = b.number
                else:
                    pairs[frozenset((a.number, b.number))] = None
        return pairs

    # -- sync --------------------------------------------------------------

    def squashed_parents(self, head: str) -> list[tuple[int, str, str, str]]:
        """Squash merges on the base of pull requests whose commits this head carries.

        Each is (pull request, its last head, the squash commit, the base just
        before it), oldest first. A merge commit needs nothing: it keeps the
        parent's commits, so a normal merge already sees them as shared.
        """
        fork = git("merge-base", head, self.remote_base, check=False).strip()
        if not fork:
            return []
        lines = git(
            "rev-list",
            "--first-parent",
            "--reverse",
            "--parents",
            f"{fork}..{self.remote_base}",
        )
        found = []
        for line in lines.splitlines():
            shas = line.split()
            if len(shas) != 2:
                continue
            subject = git("log", "-1", "--format=%s", shas[0])
            number = squash_number(subject)
            if number is None:
                continue
            ref = f"refs/autopilot/merged/{number}"
            if not git_ok(
                "fetch", "--no-tags", "origin", f"+refs/pull/{number}/head:{ref}"
            ):
                continue
            shared = git("merge-base", head, ref, check=False).strip()
            if shared and not git_ok("merge-base", "--is-ancestor", shared, shas[1]):
                found.append((number, git("rev-parse", ref).strip(), shas[0], shas[1]))
        return found

    def merge_step(self, pr: PullRequest, ref: str, label: str) -> bool:
        if git_ok("merge-base", "--is-ancestor", ref, "HEAD"):
            return True
        if git_ok(
            "merge",
            "--no-ff",
            "--no-edit",
            "-m",
            f"Merge {label} into {pr.head_ref}",
            ref,
        ):
            return True
        conflicted = git("diff", "--name-only", "--diff-filter=U").split()
        generated, others = split_conflicts(conflicted)
        for path in generated:
            git("checkout", "--theirs", "--", path)
        if others and not self.resolve_with_claude(pr, label, others):
            git("merge", "--abort", check=False)
            self.block(
                pr, CONFLICT_LABEL, f"conflits non résolus avec `{label}`", others
            )
            return False
        if (ROOT / "scripts" / "audit_findings.py").is_file():
            _run([sys.executable, "scripts/audit_findings.py", "build"], check=False)
        git("add", "-A")
        leftovers = [
            p
            for p in conflicted
            if (ROOT / p).is_file()
            and has_markers((ROOT / p).read_text(encoding="utf-8", errors="replace"))
        ]
        if leftovers or git("diff", "--name-only", "--diff-filter=U").split():
            git("merge", "--abort", check=False)
            self.block(pr, CONFLICT_LABEL, "marqueurs de conflit restants", leftovers)
            return False
        git(
            "commit",
            "--no-edit",
            "-m",
            f"Merge {label} into {pr.head_ref} (stack autopilot)",
        )
        summary(f"  - conflits résolus avec `{label}` : {', '.join(conflicted)}")
        return True

    def resolve_with_claude(
        self, pr: PullRequest, label: str, files: list[str]
    ) -> bool:
        if not self.claude:
            return False
        prompt = RESOLVE_PROMPT.format(
            branch=pr.head_ref,
            number=pr.number,
            ref=label,
            files="\n".join(f"- {f}" for f in files),
        )
        tools = (
            "Read,Edit,Write,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git log:*),"
            "Bash(git show:*),Bash(ls:*),Bash(python scripts/audit_findings.py:*)"
        )
        cmd = [
            "claude",
            "-p",
            prompt,
            "--permission-mode",
            "acceptEdits",
            "--allowedTools",
            tools,
            "--max-turns",
            "80",
        ]
        model = os.environ.get("STACK_AUTOPILOT_MODEL")
        if model:
            cmd += ["--model", model]
        try:
            subprocess.run(cmd, cwd=ROOT, timeout=25 * 60, check=False)
        except subprocess.TimeoutExpired:
            return False
        return not any(
            (ROOT / p).is_file()
            and has_markers((ROOT / p).read_text(encoding="utf-8", errors="replace"))
            for p in files
        )

    def sync(self, pr: PullRequest) -> bool:
        """Merge the base into the pull request; True when something was pushed."""
        if not self.can_push:
            summary(
                f"- #{pr.number} est en retard sur {self.base} : `PAT_TOKEN` absent, rien poussé (la CI ne tournerait pas)."
            )
            return False
        git("checkout", "--quiet", "--detach", pr.head_sha)
        for number, parent_head, squash, before in self.squashed_parents(pr.head_sha):
            # The parent's last commits first (the branch may predate them),
            # then the base it was squashed onto; the squash then adds nothing.
            if not self.merge_step(pr, parent_head, f"#{number}"):
                return False
            if not self.merge_step(pr, before, f"{self.base} before #{number}"):
                return False
            git(
                "merge",
                "-s",
                "ours",
                "--no-edit",
                "-m",
                f"Record the squash of #{number}, already in {pr.head_ref}",
                squash,
            )
            summary(
                f"  - #{number}, fusionnée en squash, absorbée sans rejouer ses conflits"
            )
        if not self.merge_step(pr, self.remote_base, self.base):
            return False
        if self.gh.dry_run:
            print(f"  [dry-run] push HEAD to {pr.head_ref}")
            return True
        if not git_ok("push", "origin", f"HEAD:refs/heads/{pr.head_ref}"):
            summary(
                f"- #{pr.number} : la branche a bougé pendant la synchro, nouvel essai au prochain passage."
            )
            return False
        summary(
            f"- #{pr.number} : {self.base} fusionnée dans `{pr.head_ref}`, poussée ; fusion quand la CI est verte."
        )
        return True

    # -- verdicts ----------------------------------------------------------

    def block(self, pr: PullRequest, label: str, why: str, files: list[str]) -> None:
        summary(f"- #{pr.number} bloquée : {why} {', '.join(files)}")
        if label in pr.labels:
            return
        self.gh.add_labels(pr.number, [label])
        pr.labels.add(label)
        listed = "\n".join(f"- `{f}`" for f in files) or "-"
        self.gh.comment(
            pr.number,
            f"Pilote de pile : {why}. Cette PR et celles qui en dépendent attendent.\n\n{listed}\n\n"
            f"Corrigez la branche puis retirez le label `{label}`.",
        )

    def verdict(self, pr: PullRequest) -> str:
        runs = self.gh.pages(
            f"repos/{self.gh.repo}/commits/{pr.head_sha}/check-runs?per_page=100",
            "check_runs",
        )
        statuses = self.gh.pages(
            f"repos/{self.gh.repo}/commits/{pr.head_sha}/statuses?per_page=100"
        )
        date = self.head_date(pr)
        age = 0.0
        if date:
            age = (
                datetime.now(UTC) - datetime.fromisoformat(date.replace("Z", "+00:00"))
            ).total_seconds()
        return checks_verdict(runs, statuses, age)

    def try_merge(self, pr: PullRequest) -> bool:
        if CONFLICT_LABEL in pr.labels:
            if not self.conflict_label_stale(pr):
                summary(
                    f"- #{pr.number} : label `{CONFLICT_LABEL}`, en attente d'une correction."
                )
                return False
            self.gh.remove_label(pr.number, CONFLICT_LABEL)
            pr.labels.discard(CONFLICT_LABEL)
        if not git_ok("merge-base", "--is-ancestor", self.remote_base, pr.head_sha):
            self.sync(pr)
            return False
        state = self.verdict(pr)
        if state == "red":
            self.block(pr, RED_LABEL, "CI rouge sur le dernier commit", [])
            return False
        if RED_LABEL in pr.labels:
            self.gh.remove_label(pr.number, RED_LABEL)
            pr.labels.discard(RED_LABEL)
        if state == "pending":
            summary(f"- #{pr.number} : à jour, CI en cours.")
            return False
        detail = self.mergeable(pr)
        if detail != "clean":
            summary(
                f"- #{pr.number} : CI verte mais GitHub dit `{detail}`, rien fusionné."
            )
            return False
        self.gh.write(
            "PUT",
            f"repos/{self.gh.repo}/pulls/{pr.number}/merge",
            {"merge_method": pr.method, "sha": pr.head_sha},
        )
        summary(f"- #{pr.number} fusionnée dans {self.base} ({pr.method}).")
        return True

    def head_date(self, pr: PullRequest) -> str | None:
        commit = self.gh.get(f"repos/{self.gh.repo}/commits/{pr.head_sha}") or {}
        return (
            commit.get("commit", {}).get("committer", {}).get("date")
            if isinstance(commit, dict)
            else None
        )

    def conflict_label_stale(self, pr: PullRequest) -> bool:
        events = self.gh.pages(
            f"repos/{self.gh.repo}/issues/{pr.number}/events?per_page=100"
        )
        return label_is_stale(events, CONFLICT_LABEL, self.head_date(pr))

    def mergeable(self, pr: PullRequest) -> str:
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

    def run(self) -> int:
        prs = self.open_prs()
        summary(f"## Pilote de pile — {len(prs)} PR inscrite(s) vers `{self.base}`")
        if not prs:
            return 0
        self.take_over_auto_merge(prs)
        self.fetch(prs)
        deps = dependencies(prs, self.related_pairs(prs))
        for pr in sorted(prs, key=lambda p: p.number):
            if deps[pr.number]:
                ahead = ", ".join(f"#{n}" for n in sorted(deps[pr.number]))
                summary(f"- #{pr.number} attend {ahead}.")
        for pr in fronts(prs, deps, self.base):
            if self.try_merge(pr):
                break  # the push to the base starts the next run
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--base", default=os.environ.get("STACK_AUTOPILOT_BASE", "develop")
    )
    parser.add_argument(
        "--repo", default=os.environ.get("GITHUB_REPOSITORY", "krovomi/WorkPilot-AI")
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    read_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", "")
    write_token = os.environ.get("PAT_TOKEN") or None
    claude = bool(
        os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("ANTHROPIC_API_KEY")
    )
    gh = GitHub(args.repo, read_token, write_token, args.dry_run)
    if not write_token:
        summary(
            "> `PAT_TOKEN` absent : le pilote fusionne ce qui est vert mais ne pousse rien (un push du jeton par défaut ne relance pas la CI)."
        )
    if not claude:
        summary(
            "> Ni `CLAUDE_CODE_OAUTH_TOKEN` ni `ANTHROPIC_API_KEY` : un conflit non mécanique bloque la PR au lieu d'être résolu."
        )
    git(
        "config",
        "user.name",
        os.environ.get("GIT_USER_NAME", "WorkPilot Stack Autopilot"),
    )
    git(
        "config", "user.email", os.environ.get("GIT_USER_EMAIL", "noreply@workpilot.ai")
    )
    return Autopilot(
        gh, args.base, can_push=write_token is not None, claude=claude
    ).run()


if __name__ == "__main__":
    sys.exit(main())

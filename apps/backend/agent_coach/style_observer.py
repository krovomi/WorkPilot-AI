"""What the coach observes in a project's git history, and at each merge.

Four kinds of commits, read from ``git log`` (argv, no shell):

- **gold**: the person's own commits (author = the project's ``user.email``)
  that no agent wrote. What they write by hand is the reference.
- **accepted**: commits of a WorkPilot build that was merged (the side of a
  ``Merge branch 'workpilot/…'`` commit, or lines recorded at a staged
  merge). The person kept them: a weaker vote for their style.
- **corrected**: lines of a merged build that a later commit of the person
  removed. The person disliked them: a vote against their style.
- **team**: the other authors' commits, a weak prior for someone with no
  history of their own ("the project's conventions").

An agent's commit is recognised by its trailers (``Co-Authored-By`` naming an
AI tool), by being on a merged ``workpilot/`` branch, or by its added lines
matching a merge recorded here. Only hashes of lines are kept
(``.workpilot/coach/merged.jsonl``), never the lines.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from foundation.git_executable import run_git

from .style_dimensions import measure

__all__ = [
    "Commit",
    "Observation",
    "MERGED",
    "line_hash",
    "observe",
    "on_merge",
    "person_email",
    "record_merge",
]

MERGED = Path(".workpilot") / "coach" / "merged.jsonl"
MAX_COMMITS = 300
MAX_HASHES = 4000
MAX_LINES_PER_FILE = 400
_SINCE_DAYS = 365
_AI_TRAILER = re.compile(
    r"(?im)^(?:co-authored-by|generated-by|assisted-by|ai-assisted):.*\b(?:claude|anthropic|copilot|"
    r"codex|openai|chatgpt|gemini|cursor|windsurf|devin|aider|openhands|workpilot|amazon q|jules)\b"
)
_WORKPILOT_MERGE = re.compile(r"\bworkpilot/[\w.-]+")


@dataclass
class Commit:
    sha: str
    email: str
    at: float
    message: str


@dataclass
class Observation:
    """The votes of one file of one commit, with what kind of commit it was."""

    kind: str  # gold | accepted | corrected | team
    language: str
    at: float
    votes: Counter = field(default_factory=Counter)


def line_hash(line: str) -> str | None:
    """A short hash of a line worth matching (8+ characters once stripped), or None."""
    text = " ".join(line.split())
    if len(text) < 8:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def person_email(root: Path) -> str:
    result = run_git(["config", "user.email"], cwd=root, timeout=10)
    return result.stdout.strip().lower() if result.returncode == 0 else ""


def _commits(root: Path) -> list[Commit]:
    result = run_git(
        [
            "log",
            "--no-merges",
            f"--since={_SINCE_DAYS}.days",
            f"-n{MAX_COMMITS}",
            "--format=%H%x1f%ae%x1f%ct%x1f%B%x1e",
        ],
        cwd=root,
        timeout=60,
    )
    if result.returncode != 0:
        return []
    commits = []
    for record in result.stdout.split("\x1e"):
        parts = record.strip("\n").split("\x1f")
        if len(parts) == 4 and parts[0].strip():
            commits.append(
                Commit(
                    parts[0].strip(), parts[1].lower(), float(parts[2] or 0), parts[3]
                )
            )
    return commits


def _merged_build_commits(root: Path) -> set[str]:
    """Commits reachable only from the second parent of a ``workpilot/`` merge."""
    result = run_git(
        [
            "log",
            "--merges",
            f"--since={_SINCE_DAYS}.days",
            "-n200",
            "--format=%H%x1f%P%x1f%s",
        ],
        cwd=root,
        timeout=60,
    )
    shas: set[str] = set()
    if result.returncode != 0:
        return shas
    for line in result.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 3 or not _WORKPILOT_MERGE.search(parts[2]):
            continue
        parents = parts[1].split()
        if len(parents) < 2:
            continue
        side = run_git(
            ["rev-list", f"{parents[0]}..{parents[1]}"], cwd=root, timeout=30
        )
        if side.returncode == 0:
            shas.update(s.strip() for s in side.stdout.split() if s.strip())
    return shas


def _diff(root: Path, sha: str) -> dict[str, tuple[list[str], list[str]]]:
    """Added and removed lines per file of one commit."""
    result = run_git(
        ["show", "--format=", "--unified=0", "--no-color", "--no-renames", sha],
        cwd=root,
        timeout=30,
    )
    files: dict[str, tuple[list[str], list[str]]] = {}
    if result.returncode != 0:
        return files
    current: tuple[list[str], list[str]] | None = None
    for line in result.stdout.splitlines():
        if line.startswith("+++ "):
            path = line[4:].removeprefix("b/")
            current = None if path == "/dev/null" else files.setdefault(path, ([], []))
        elif (
            line.startswith("--- ") or line.startswith("@@") or line.startswith("diff ")
        ):
            continue
        elif current is not None and line.startswith("+"):
            if len(current[0]) < MAX_LINES_PER_FILE:
                current[0].append(line[1:])
        elif current is not None and line.startswith("-"):
            if len(current[1]) < MAX_LINES_PER_FILE:
                current[1].append(line[1:])
    return files


def recorded_merges(root: Path) -> list[dict]:
    path = root / MERGED
    if path.is_symlink() or not path.is_file():
        return []
    merges = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        try:
            line = json.loads(raw)
        except ValueError:
            continue
        if isinstance(line, dict) and isinstance(line.get("hashes"), list):
            merges.append(line)
    return merges


def observe(root: Path) -> tuple[list[Observation], dict]:
    """Every observation of the project's history, and what was read.

    The second value counts the commits of each kind, and carries the recorded
    merges and the line hashes each of the person's commits removed, which
    ``profile_builder.outcomes`` turns into "kept as is" or "corrected".
    """
    email = person_email(root)
    merges = recorded_merges(root)
    ai_lines = {h for merge in merges for h in merge["hashes"] if isinstance(h, str)}
    build_commits = _merged_build_commits(root)
    observations: list[Observation] = []
    counts = Counter()
    removals: list[tuple[float, set[str]]] = []
    read = [(commit, _diff(root, commit.sha)) for commit in _commits(root)]
    for commit, files in read:
        if commit.sha in build_commits:
            ai_lines.update(
                h
                for added, _ in files.values()
                for line in added
                if (h := line_hash(line))
            )
    for commit, files in read:
        added_hashes = [
            h for added, _ in files.values() for line in added if (h := line_hash(line))
        ]
        agent = (
            commit.sha in build_commits
            or bool(_AI_TRAILER.search(commit.message))
            or (
                bool(added_hashes)
                and sum(h in ai_lines for h in added_hashes) * 2 >= len(added_hashes)
            )
        )
        if agent:
            kind = "accepted" if added_hashes else "agent"
        elif email and commit.email == email:
            kind = "gold"
        else:
            kind = "team"
        if kind == "agent":
            counts["agent"] += 1
            continue
        counts[kind] += 1
        for path, (added, removed) in files.items():
            language, votes = measure(path, added)
            if language and votes:
                observations.append(Observation(kind, language, commit.at, votes))
            if kind == "gold" and removed:
                removals.append(
                    (commit.at, {h for line in removed if (h := line_hash(line))})
                )
                theirs = [
                    line for line in removed if (h := line_hash(line)) and h in ai_lines
                ]
                if len(theirs) >= 3:
                    language, votes = measure(path, theirs)
                    if language and votes:
                        observations.append(
                            Observation("corrected", language, commit.at, votes)
                        )
                        counts["corrected"] += 1
    return observations, {
        "email": bool(email),
        "removals": removals,
        "merges": merges,
        **counts,
    }


def _merge_diff(root: Path, spec_name: str) -> list[str]:
    """Lines a merge of *spec_name* brought: staged, else the branch against HEAD's first parent."""
    staged = run_git(
        ["diff", "--cached", "--unified=0", "--no-color"], cwd=root, timeout=30
    )
    text = staged.stdout if staged.returncode == 0 else ""
    if not text.strip():
        branch = f"workpilot/{spec_name}"
        exists = run_git(
            ["rev-parse", "--verify", "--quiet", branch], cwd=root, timeout=10
        )
        if exists.returncode != 0:
            return []
        ranged = run_git(
            ["diff", "--unified=0", "--no-color", f"HEAD^1...{branch}"],
            cwd=root,
            timeout=30,
        )
        text = ranged.stdout if ranged.returncode == 0 else ""
    return [
        line[1:]
        for line in text.splitlines()
        if line.startswith("+") and not line.startswith("+++")
    ]


def record_merge(root: Path, spec_name: str, coached: bool) -> int:
    """Append the line hashes of a merged build; returns how many were kept."""
    folder = root / ".workpilot"
    if folder.is_symlink() or not folder.is_dir():
        return 0
    coach = folder / "coach"
    if coach.is_symlink():
        return 0
    coach.mkdir(exist_ok=True)
    hashes = sorted(
        {h for line in _merge_diff(root, spec_name) if (h := line_hash(line))}
    )[:MAX_HASHES]
    target = root / MERGED
    if target.is_symlink():
        return 0
    entry = {
        "spec": spec_name,
        "at": int(time.time()),
        "coached": coached,
        "hashes": hashes,
    }
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")
    return len(hashes)


def on_merge(event) -> None:
    """`core.merge_event` subscriber: remember what the build brought, and whether the coach was on."""
    from .profile_store import coaching_active

    root = Path(event.project_dir)
    record_merge(root, event.spec_name, coaching_active(root))

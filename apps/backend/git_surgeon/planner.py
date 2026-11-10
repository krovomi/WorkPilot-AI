"""The rewrite plan of a branch: which commits to squash, reword, split or keep.

Algorithmic, no model (a model only rewords, ``messages.py``):

- **autosquash**: ``fixup! X``, ``squash! X``, ``amend! X`` join the commit X;
- **fix-ups**: a vague commit (``wip``, ``fix``, ``typo``…) or a small fix of
  files the previous commit touched joins it, only inside the same part of the
  project (``domains.py``): three Auth fixes and four Payment fixes give two
  commits, never one;
- **split**: a commit of ``split_files`` files or ``split_lines`` lines over
  several parts becomes one commit per part (migrations, build, code, tests,
  docs, CI);
- **reword**: a message that does not follow the project's convention;
- everything else is **kept**, its message as it is.

Every rewritten message keeps its trailers (``Co-authored-by``, ``Refs``,
``Signed-off-by``…) and its PR reference ``(#123)``; a squash adds the other
authors as co-authors and lists the subjects it joined.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .commits import Commit
from .conventions import (
    Convention,
    autosquash_target,
    conforms,
    guess_type,
    is_vague,
    readability,
    suggest_message,
)
from .domains import domains_of

SPLIT_FILES = 12
SPLIT_LINES = 400
SMALL_FIX_LINES = 40
_TRAILER = re.compile(r"^[A-Za-z][\w-]{1,40}: \S.*$")
_PR_REF = re.compile(r"\((?:#|!)\d{1,7}\)")
KINDS = ("keep", "reword", "squash", "split")


@dataclass
class Planned:
    id: str
    kind: str
    sources: list[str]
    message: str
    reason: str = ""
    paths: list[str] = field(default_factory=list)
    author: str = ""
    conforms: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": self.kind,
            "sources": self.sources,
            "message": self.message,
            "reason": self.reason,
            "paths": self.paths,
            "author": self.author,
            "conforms": self.conforms,
        }


def trailers(message: str) -> list[str]:
    paragraphs = [p for p in message.strip().split("\n\n") if p.strip()]
    if len(paragraphs) < 2:
        return []
    lines = paragraphs[-1].splitlines()
    return lines if all(_TRAILER.match(line) for line in lines) else []


def _body(message: str) -> str:
    """The message without its subject line and its trailers."""
    paragraphs = [p.strip() for p in message.strip().split("\n\n") if p.strip()]
    if paragraphs:
        first = paragraphs[0].split("\n", 1)
        paragraphs[0] = first[1].strip() if len(first) > 1 else ""
    if trailers(message) and len(paragraphs) > 1:
        paragraphs = paragraphs[:-1]
    return "\n\n".join(p for p in paragraphs if p)


def _with_ref(subject: str, originals: list[str]) -> str:
    if _PR_REF.search(subject):
        return subject
    for original in originals:
        match = _PR_REF.search(original)
        if match:
            return f"{subject} {match.group(0)}"
    return subject


def compose(subject: str, body: str, trailer_lines: list[str]) -> str:
    message = subject.strip()
    if body.strip():
        message += "\n\n" + body.strip()
    unique = list(dict.fromkeys(t for t in trailer_lines if t.strip()))
    if unique:
        message += "\n\n" + "\n".join(unique)
    return message


def _paths(group: list[Commit]) -> list[str]:
    return list(dict.fromkeys(f.path for c in group for f in c.files))


def _joins(previous: list[Commit], commit: Commit) -> bool:
    """Whether ``commit`` is a fix-up of the group just before it."""
    mine, theirs = domains_of(_paths([commit])), domains_of(_paths(previous))
    if not mine or not set(mine) <= set(theirs):
        return False
    if is_vague(commit.subject):
        return True
    small = commit.lines <= SMALL_FIX_LINES
    same_files = set(_paths([commit])) <= set(_paths(previous))
    return small and same_files and guess_type(commit.subject, mine) in ("fix", "style")


def _groups(commits: list[Commit]) -> tuple[list[list[Commit]], dict[int, str]]:
    groups: list[list[Commit]] = []
    reasons: dict[int, str] = {}
    for commit in commits:
        target = autosquash_target(commit.subject)
        if target:
            for index in range(len(groups) - 1, -1, -1):
                head = groups[index][0].subject
                if head == target or head.startswith(target):
                    groups[index].append(commit)
                    reasons[id(groups[index])] = "autosquash"
                    break
            else:
                groups.append([commit])
            continue
        if groups and not groups[-1][0].is_merge and _joins(groups[-1], commit):
            groups[-1].append(commit)
            reasons.setdefault(id(groups[-1]), "fixups")
            continue
        groups.append([commit])
    return groups, {i: reasons.get(id(g), "") for i, g in enumerate(groups)}


def _squash(
    group: list[Commit], convention: Convention, reason: str, next_id
) -> Planned:
    subjects = [c.subject for c in group]
    paths = _paths(group)
    useful = [s for s in subjects if not is_vague(s) and not autosquash_target(s)]
    good = next((s for s in useful if conforms(s, convention)), None)
    subject = _with_ref(
        good or suggest_message(subjects, paths, domains_of(paths), convention),
        subjects,
    )
    # the subject the new one is made from is not listed again under it
    joined = [s for s in useful if s != (good or (useful[0] if useful else None))]
    body = _body(group[0].message)
    if joined:
        body = (body + "\n\n" if body else "") + "\n".join(f"- {s}" for s in joined)
    lines = [t for c in group for t in trailers(c.message)]
    first = group[0]
    for other in group[1:]:
        if other.author_email.lower() != first.author_email.lower():
            lines.append(f"Co-authored-by: {other.author_name} <{other.author_email}>")
    return Planned(
        next_id(),
        "squash",
        [c.sha for c in group],
        compose(subject, body, lines),
        reason,
        [],
        first.author_name,
    )


def _split(
    commit: Commit, domains: list[str], convention: Convention, next_id
) -> list[Planned]:
    parts: list[Planned] = []
    for index, domain in enumerate(domains):
        paths = [f.path for f in commit.files if domains_of([f.path]) == [domain]]
        subject = _with_ref(
            suggest_message([commit.subject], paths, [domain], convention),
            [commit.subject],
        )
        body = _body(commit.message) if index == 0 else ""
        parts.append(
            Planned(
                next_id(),
                "split",
                [commit.sha],
                compose(subject, body, trailers(commit.message)),
                "mixed",
                paths,
                commit.author_name,
            )
        )
    return parts


def build_plan(
    commits: list[Commit],
    convention: Convention,
    *,
    split_files: int = SPLIT_FILES,
    split_lines: int = SPLIT_LINES,
) -> list[Planned]:
    counter = iter(range(1, 10_000))

    def next_id() -> str:
        return f"p{next(counter)}"

    plan: list[Planned] = []
    groups, reasons = _groups(commits)
    for index, group in enumerate(groups):
        if len(group) > 1:
            plan.append(_squash(group, convention, reasons[index], next_id))
            continue
        commit = group[0]
        domains = domains_of([f.path for f in commit.files])
        big = len(commit.files) >= split_files or commit.lines >= split_lines
        if not commit.is_merge and big and len(domains) >= 2:
            plan.extend(_split(commit, domains, convention, next_id))
        elif not commit.is_merge and not conforms(commit.subject, convention):
            subject = _with_ref(
                suggest_message(
                    [commit.subject],
                    [f.path for f in commit.files],
                    domains,
                    convention,
                ),
                [commit.subject],
            )
            reason = "vague" if is_vague(commit.subject) else "convention"
            plan.append(
                Planned(
                    next_id(),
                    "reword",
                    [commit.sha],
                    compose(subject, _body(commit.message), trailers(commit.message)),
                    reason,
                    [],
                    commit.author_name,
                )
            )
        else:
            plan.append(
                Planned(
                    next_id(),
                    "keep",
                    [commit.sha],
                    commit.message,
                    "",
                    [],
                    commit.author_name,
                )
            )
    for step in plan:
        step.conforms = conforms(step.message.split("\n", 1)[0], convention)
    return plan


def first_rewritten(commits: list[Commit], plan: list[Planned]) -> int:
    """How many commits keep their sha: the untouched ones before the first change."""
    kept = 0
    for step, commit in zip(plan, commits, strict=False):
        if step.kind != "keep" or step.sources != [commit.sha]:
            break
        kept += 1
    return kept


def score(plan_messages: list[str], convention: Convention) -> dict[str, int]:
    return readability([m.split("\n", 1)[0] for m in plan_messages], convention)

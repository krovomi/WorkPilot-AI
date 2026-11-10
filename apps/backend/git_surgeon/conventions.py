"""The commit message convention of a project, and messages written to it.

The convention is read, in order, from ``.workpilot/git-surgeon.json``
(``{"convention": "conventional" | "gitmoji" | "custom", "pattern": "..."}``),
a commitlint or gitmoji configuration, then the last hundred subjects (half of
them following one is enough). A project file is data (S2): size capped, a
link never followed, a custom pattern compiled with a length cap.

``suggest_message`` writes a message by rules, offline: the type from the
words of the old subject and the files, the scope from the part touched. A
model may write better ones (``messages.py``); these are the fallback.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

CONVENTIONAL = re.compile(
    r"^(?P<type>feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)"
    r"(?:\((?P<scope>[^()\s]{1,40})\))?!?: \S"
)
GITMOJI = re.compile(r"^(?::[a-z0-9_+-]{1,40}:|[☀-➿\U0001f300-\U0001faff])️?\s+\S")
_VAGUE = re.compile(
    r"^(wip|fixup|tmp|temp|test|tests|asdf|qwe|xxx|todo|hack|stuff|update[sd]?|changes?|"
    r"fix(es|ed)?|minor|misc|cleanup|clean up|typo|oops|more|again|review|lint|format|\W*)\W*$",
    re.IGNORECASE,
)
_AUTOSQUASH = re.compile(r"^(fixup|squash|amend)! (?P<target>.+)$")
MAX_SUBJECT = 100
_CONFIG_BYTES = 16 * 1024
_COMMITLINT = (
    "commitlint.config.js",
    "commitlint.config.cjs",
    "commitlint.config.mjs",
    "commitlint.config.ts",
    ".commitlintrc",
    ".commitlintrc.json",
    ".commitlintrc.yml",
    ".commitlintrc.yaml",
    ".czrc",
    ".cz.toml",
)
_GITMOJI_FILES = (".gitmojirc.json",)
EMOJI = {
    "feat": ":sparkles:",
    "fix": ":bug:",
    "docs": ":memo:",
    "test": ":white_check_mark:",
    "refactor": ":recycle:",
    "perf": ":zap:",
    "build": ":package:",
    "ci": ":construction_worker:",
    "style": ":art:",
    "chore": ":wrench:",
    "revert": ":rewind:",
}
_WORDS = (
    ("revert", re.compile(r"\brevert", re.I)),
    (
        "fix",
        re.compile(
            r"\b(fix|bug|correct|repair|resolve|hotfix|patch|crash|broken)", re.I
        ),
    ),
    ("perf", re.compile(r"\b(perf|speed|faster|optimi[sz])", re.I)),
    (
        "refactor",
        re.compile(r"\b(refactor|rename|move|extract|simplif|restructur)", re.I),
    ),
    ("docs", re.compile(r"\b(doc|readme|changelog|comment)", re.I)),
    ("test", re.compile(r"\b(test|spec|coverage)", re.I)),
    ("build", re.compile(r"\b(bump|deps?|dependenc|upgrade|package)", re.I)),
    ("ci", re.compile(r"\b(ci|pipeline|workflow)\b", re.I)),
    ("style", re.compile(r"\b(lint|format|prettier|whitespace)", re.I)),
    (
        "feat",
        re.compile(r"\b(add|new|feat|implement|support|introduc|create|allow)", re.I),
    ),
)
_DOMAIN_TYPE = {"tests": "test", "docs": "docs", "ci": "ci", "build": "build"}


@dataclass
class Convention:
    kind: str  # conventional | gitmoji | custom
    source: str  # project, commitlint, gitmoji, history, default
    pattern: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "source": self.source, "pattern": self.pattern}


def _project_file(repo: Path) -> dict | None:
    path = repo / ".workpilot" / "git-surgeon.json"
    try:
        if (
            path.is_symlink()
            or not path.is_file()
            or path.stat().st_size > _CONFIG_BYTES
        ):
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _custom(pattern: object) -> re.Pattern[str] | None:
    if not isinstance(pattern, str) or not pattern or len(pattern) > 200:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


def detect_convention(repo: Path, subjects: list[str]) -> Convention:
    data = _project_file(repo) or {}
    kind = data.get("convention")
    if kind == "custom" and _custom(data.get("pattern")):
        return Convention("custom", "project", str(data["pattern"]))
    if kind in ("conventional", "gitmoji"):
        return Convention(str(kind), "project")
    if any((repo / name).is_file() for name in _COMMITLINT):
        return Convention("conventional", "commitlint")
    if any((repo / name).is_file() for name in _GITMOJI_FILES):
        return Convention("gitmoji", "gitmoji")
    if subjects:
        for name, regex in (("conventional", CONVENTIONAL), ("gitmoji", GITMOJI)):
            if sum(1 for s in subjects if regex.match(s)) * 2 >= len(subjects):
                return Convention(name, "history")
    return Convention("conventional", "default")


def conforms(subject: str, convention: Convention) -> bool:
    subject = subject.strip()
    if not subject or len(subject) > MAX_SUBJECT or is_vague(subject):
        return False
    if convention.kind == "custom":
        regex = _custom(convention.pattern)
        return bool(regex and regex.search(subject))
    regex = GITMOJI if convention.kind == "gitmoji" else CONVENTIONAL
    return bool(regex.match(subject))


def is_vague(subject: str) -> bool:
    subject = subject.strip()
    text = subject.split(": ", 1)[-1] if CONVENTIONAL.match(subject) else subject
    return bool(_VAGUE.match(subject) or _VAGUE.match(text) or len(text) < 4)


def autosquash_target(subject: str) -> str | None:
    match = _AUTOSQUASH.match(subject.strip())
    return match.group("target").strip() if match else None


def readability(subjects: list[str], convention: Convention) -> dict[str, int]:
    total = len(subjects)
    ok = sum(1 for s in subjects if conforms(s, convention))
    return {
        "conforming": ok,
        "total": total,
        "percent": round(100 * ok / total) if total else 100,
    }


def guess_type(subject: str, domains: list[str]) -> str:
    match = CONVENTIONAL.match(subject)
    if match:
        return match.group("type")
    if len(domains) == 1 and domains[0] in _DOMAIN_TYPE:
        return _DOMAIN_TYPE[domains[0]]
    for name, regex in _WORDS:
        if regex.search(subject):
            return name
    return "chore"


def _clean_subject(subject: str) -> str:
    text = subject.strip()
    if CONVENTIONAL.match(text):
        text = text.split(": ", 1)[-1]
    elif GITMOJI.match(text):
        text = text.split(None, 1)[-1]
    text = re.sub(r"^(wip|tmp)\b[:\s]*", "", text, flags=re.I).strip(" .:-")
    return (
        text[:1].lower() + text[1:]
        if text[:1].isupper() and not text[1:2].isupper()
        else text
    )


def describe_files(paths: list[str]) -> str:
    names = sorted({Path(p).stem for p in paths if p})[:3]
    if not names:
        return "update files"
    more = "" if len(paths) <= 3 else f" and {len(paths) - 3} more"
    return "update " + ", ".join(names) + more


def suggest_message(
    subjects: list[str], paths: list[str], domains: list[str], convention: Convention
) -> str:
    """One subject line for commits ``subjects`` touching ``paths``, by rules."""
    useful = [s for s in subjects if not is_vague(s) and not autosquash_target(s)]
    base = _clean_subject(useful[0]) if useful else describe_files(paths)
    kind = guess_type(useful[0] if useful else " ".join(subjects), domains)
    scope = (
        domains[0]
        if len(domains) == 1 and domains[0] not in ("root", *_DOMAIN_TYPE)
        else ""
    )
    scope = re.sub(r"[^\w.-]", "", scope.lower())[:30]
    if convention.kind == "gitmoji":
        line = f"{EMOJI.get(kind, ':wrench:')} {base[:1].upper()}{base[1:]}"
    elif convention.kind == "custom":
        line = useful[0] if useful else base
    else:
        line = f"{kind}({scope}): {base}" if scope else f"{kind}: {base}"
    return line[:MAX_SUBJECT].rstrip()

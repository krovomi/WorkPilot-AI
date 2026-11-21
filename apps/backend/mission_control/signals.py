"""What the composition is decided from, read without a model.

A spec directory, a free description, or both. Nothing here spends a token:

* the kind of the work — ``tasks.classify`` (the card's own kind when the user
  chose one, else its category, imported type or words, French and English);
* its size — characters of the spec, files the implementation plan touches
  (``cost_intelligence.extract_spec_footprint``) or that the text names;
* its domains — a closed list (``DOMAINS``) matched on words, any language of
  code: a "screen" is frontend in Rust as in TypeScript;
* the project's stack — ``project.stack.detect_project_stack``: its languages
  and whether it has a test runner, for every stack that module knows.

The text is the person's own or a spec of their project: it is only matched
against fixed patterns here, never executed and never sent anywhere.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from cost_intelligence.cost_predictor import extract_spec_footprint
from project.stack import detect_project_stack
from tasks.classify import TaskKind, classify
from tasks.metadata import read_task_metadata

logger = logging.getLogger(__name__)

CHARS_PER_TOKEN = 4
# Read from a spec directory, in this order; the rest of it is the agents' own.
SPEC_FILES = ("spec.md", "requirements.json")
MAX_SPEC_CHARS = 200_000
# A description shorter than this, with no spec behind it, says too little,
# unless it names its kind of work ("fix the login crash"); under MIN_WORDS
# even that is not enough.
VAGUE_WORDS = 6
MIN_WORDS = 3

COMPLEXITIES = ("small", "medium", "large")

DOMAINS: dict[str, tuple[str, ...]] = {
    "frontend": (
        r"\bui\b",
        r"\bux\b",
        r"\bfrontend\b",
        r"\bfront-end\b",
        r"\bcomponents?\b",
        r"\bcomposants?\b",
        r"\bpages?\b",
        r"\bscreens?\b",
        r"\becrans?\b",
        r"\bcss\b",
        r"\bbuttons?\b",
        r"\bboutons?\b",
        r"\bforms?\b",
        r"\bformulaires?\b",
    ),
    "backend": (
        r"\bapi\b",
        r"\bbackend\b",
        r"\bback-end\b",
        r"\bserver\b",
        r"\bserveur\b",
        r"\bendpoints?\b",
        r"\bservices?\b",
        r"\broutes?\b",
        r"\bworkers?\b",
    ),
    "database": (
        r"\bdatabase\b",
        r"\bbase de donnees\b",
        r"\bsql\b",
        r"\bschema\b",
        r"\bmigrations?\b",
        r"\btables?\b",
        r"\bqueries\b",
        r"\bquery\b",
        r"\brequetes?\b",
    ),
    "mobile": (
        r"\bmobile\b",
        r"\bios\b",
        r"\bandroid\b",
        r"\bsmartphone\b",
    ),
    "infra": (
        r"\bdocker\b",
        r"\bkubernetes\b",
        r"\bdeploy(?:ment)?\b",
        r"\bdeploiement\b",
        r"\bci\b",
        r"\bpipeline\b",
        r"\bterraform\b",
        r"\binfra(?:structure)?\b",
    ),
    "docs": (
        r"\bdocs?\b",
        r"\bdocumentation\b",
        r"\breadme\b",
        r"\bguide\b",
    ),
}

_TESTS = (r"\btests?\b", r"\btesting\b", r"\bcoverage\b", r"\bcouverture\b")
# A path or a file name with an extension: `src/app.ts`, `Program.cs`, `main.go`.
#: A run of path characters, then its folder names and a file's stem and
#: extension, each matched whole (no pattern that can retry a long run).
_PATH_TOKEN = re.compile(r"[\w/.-]+")
_SEGMENT = re.compile(r"[\w-]+")
_EXTENSION = re.compile(r"[a-z0-9]{1,6}")


def _file_named(token: str) -> str | None:
    """The file a path-like token names (``src/app.ts``), or None."""
    folders: list[str] = []
    for segment in token.split("/"):
        stem, dot, rest = segment.partition(".")
        extension = re.split(r"[.-]", rest, maxsplit=1)[0]
        if dot and _SEGMENT.fullmatch(stem) and _EXTENSION.fullmatch(extension):
            return "/".join([*folders, f"{stem}.{extension}"])
        if not _SEGMENT.fullmatch(segment):
            return None
        folders.append(segment)
    return None


@dataclass
class CompositionSignals:
    """The facts a composition is built from."""

    words: int = 0
    spec_tokens: int = 0
    touched_files: int = 0
    subtasks: int = 0
    domains: list[str] = field(default_factory=list)
    mentions_tests: bool = False
    has_test_suite: bool = False
    languages: list[str] = field(default_factory=list)
    kind: str = TaskKind.FEATURE.value
    kind_confident: bool = False
    has_spec: bool = False

    @property
    def vague(self) -> bool:
        """Too little to tell what the work is: a word or two, or a short
        text that names no kind of work."""
        if self.has_spec:
            return False
        return self.words < MIN_WORDS or (
            self.words < VAGUE_WORDS and not self.kind_confident
        )

    @property
    def complexity(self) -> str:
        """``small``, ``medium`` or ``large``, from size, files and domains."""
        score = (
            self.spec_tokens / 1_500
            + self.touched_files / 4
            + self.subtasks / 3
            + max(0, len(self.domains) - 1) * 0.75
        )
        if score < 2:
            return "small"
        if score < 5:
            return "medium"
        return "large"

    def to_dict(self) -> dict[str, object]:
        return {
            "words": self.words,
            "spec_tokens": self.spec_tokens,
            "touched_files": self.touched_files,
            "subtasks": self.subtasks,
            "domains": list(self.domains),
            "mentions_tests": self.mentions_tests,
            "has_test_suite": self.has_test_suite,
            "languages": list(self.languages),
            "kind": self.kind,
            "has_spec": self.has_spec,
        }


def normalise(text: str) -> str:
    """Lower case, accents removed, spaces collapsed."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.lower()).strip()


def _any(text: str, patterns: tuple[str, ...]) -> bool:
    return any(re.search(p, text) for p in patterns)


def read_spec_text(spec_dir: Path) -> str:
    """The spec's own text, capped; empty when it has none."""
    parts: list[str] = []
    for name in SPEC_FILES:
        path = spec_dir / name
        if not path.is_file():
            continue
        try:
            parts.append(path.read_text(encoding="utf-8", errors="replace"))
        except OSError as exc:
            logger.debug("could not read %s: %s", name, exc)
    return "\n\n".join(parts)[:MAX_SPEC_CHARS]


def read_signals(
    prompt: str = "",
    project_dir: Path | None = None,
    spec_dir: Path | None = None,
) -> CompositionSignals:
    """The signals of a description, a spec, or both. Never raises."""
    spec_text = read_spec_text(spec_dir) if spec_dir else ""
    text = "\n\n".join(t for t in (prompt.strip(), spec_text) if t)
    norm = normalise(text)

    signals = CompositionSignals(
        words=len(norm.split()),
        spec_tokens=len(text) // CHARS_PER_TOKEN,
        has_spec=bool(spec_text),
        domains=[d for d, patterns in DOMAINS.items() if _any(norm, patterns)],
        mentions_tests=_any(norm, _TESTS),
    )

    named_files = len(
        {name for token in _PATH_TOKEN.findall(text) if (name := _file_named(token))}
    )
    metadata: dict[str, object] = {}
    if spec_dir:
        footprint = extract_spec_footprint(spec_dir)
        if footprint.has_implementation_plan:
            signals.subtasks = footprint.subtask_count
        signals.touched_files = footprint.touched_files
        metadata = read_task_metadata(spec_dir)
    signals.touched_files = max(signals.touched_files, named_files)

    verdict = classify(prompt.strip()[:500], spec_text[:5_000], metadata)
    signals.kind = verdict.kind.value
    # Anything but the default verdict: a word, a category, a chosen kind.
    signals.kind_confident = verdict.source != "default"

    if project_dir:
        stack = detect_project_stack(project_dir)
        signals.languages = list(stack.get("languages") or [])
        signals.has_test_suite = bool(stack.get("test_runners"))
    return signals


__all__ = [
    "COMPLEXITIES",
    "DOMAINS",
    "CompositionSignals",
    "normalise",
    "read_signals",
    "read_spec_text",
]

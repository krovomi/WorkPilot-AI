"""The index of `docs/architecture/`, read from the files themselves.

Each design file starts with a frontmatter that says what it covers::

    ---
    feature: Mode serveur
    summary: >-
      Une équipe sur un serveur : organisations, rôles, groupes...
    ---

There is no hand-written table to keep in sync: `docs/CLAUDE.md` used to carry
one row per feature, so every feature PR edited the same table, parallel PRs
conflicted on it and its size cap broke on `develop` after each batch of
merges. A new feature now adds one file and touches nothing shared.

    python scripts/docs_index.py              # the whole index, as a Markdown table
    python scripts/docs_index.py sandbox mcp  # only the rows that mention a word
    python scripts/docs_index.py --check      # every file has a valid frontmatter
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
ARCHITECTURE = ROOT / "docs" / "architecture"

# A summary is what the old table row said: one or two sentences, not the page.
MAX_FEATURE_CHARS = 60
MAX_SUMMARY_CHARS = 400


@dataclass(frozen=True)
class Entry:
    name: str
    feature: str
    summary: str


def read(path: Path) -> Entry:
    """The frontmatter of one design file; ValueError says what is wrong with it."""
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        raise ValueError("starts without a frontmatter (---, feature:, summary:, ---)")
    end = text.find("\n---\n", 4)
    if end < 0:
        raise ValueError("frontmatter is not closed by a --- line")
    try:
        data = yaml.safe_load(text[4:end])
    except yaml.YAMLError as error:
        raise ValueError(f"frontmatter is not valid YAML: {error}") from None
    if not isinstance(data, dict) or set(data) != {"feature", "summary"}:
        raise ValueError("frontmatter must hold exactly `feature` and `summary`")
    feature, summary = data["feature"], data["summary"]
    if not isinstance(feature, str) or not feature.strip():
        raise ValueError("`feature` must be a non-empty string")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError(
            "`summary` must be a non-empty string (use `>-` for a long one)"
        )
    if len(feature) > MAX_FEATURE_CHARS:
        raise ValueError(
            f"`feature` has {len(feature)} characters (max {MAX_FEATURE_CHARS})"
        )
    if len(summary) > MAX_SUMMARY_CHARS:
        raise ValueError(
            f"`summary` has {len(summary)} characters (max {MAX_SUMMARY_CHARS}): "
            "the detail goes in the body"
        )
    if "](" in summary or "|" in summary:
        raise ValueError(
            "`summary` holds no Markdown link and no `|`: name files in backticks"
        )
    return Entry(path.name, feature.strip(), " ".join(summary.split()))


def entries(directory: Path = ARCHITECTURE) -> list[Entry]:
    return [read(path) for path in sorted(directory.glob("*.md"))]


def render(items: list[Entry], prefix: str = "docs/architecture/") -> str:
    lines = ["| Feature | Fichier | Contenu |", "|---|---|---|"]
    lines += [
        f"| {e.feature} | [{e.name}]({prefix}{e.name}) | {e.summary} |" for e in items
    ]
    return "\n".join(lines) + "\n"


def _matches(entry: Entry, words: list[str]) -> bool:
    haystack = f"{entry.name} {entry.feature} {entry.summary}".casefold()
    return all(word.casefold() in haystack for word in words)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "words", nargs="*", help="keep only the rows holding every word"
    )
    parser.add_argument(
        "--check", action="store_true", help="validate every frontmatter"
    )
    args = parser.parse_args(argv)

    if args.check:
        errors = []
        for path in sorted(ARCHITECTURE.glob("*.md")):
            try:
                read(path)
            except ValueError as error:
                errors.append(f"docs/architecture/{path.name}: {error}")
        print("\n".join(errors) or "docs/architecture: every file has its frontmatter")
        return 1 if errors else 0

    items = [e for e in entries() if _matches(e, args.words)]
    sys.stdout.write(render(items))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())

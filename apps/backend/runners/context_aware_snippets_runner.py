#!/usr/bin/env python3
"""
Context-Aware Snippets Runner — a code snippet written the way the project writes code.

The sidebar's "Extraits contextuels" dialog spawns this runner through
``context-aware-snippets-service.ts``. It never worked: it imported
``core.context_manager``, ``services.project_analyzer`` and
``memory.bmad_memory``, none of which exist, so every run answered "under
development"; behind that, the model call went to an ``agents.claude_agent_sdk``
that does not exist either, and the "project context" was a hard-coded list
(react, lodash…) whatever the project was.

What it does now, in three steps:

1. **Project context, without a model.** The bounded brief the prompt optimizer
   already reads (``core.project_brief``: stack, layout, ``AGENTS.md`` /
   ``CLAUDE.md`` / README excerpts), the formatter and linter configuration the
   project declares at its root, and **one existing file** of the target
   language — the strongest evidence of a house style there is. The file is
   chosen from ``git ls-files`` (a bounded walk otherwise), by the kind of
   snippet asked for, and is not sent at all when the secret scanner flags it
   or cannot load.
2. **One completion, on whatever provider is active.** Through
   ``core.oneshot.oneshot_completion`` — provider-agnostic, so the
   ``SELECTED_LLM_PROVIDER`` the Electron side sets from the default provider is
   honoured.
3. **One JSON object, parsed leniently.** ``spec.plan_recovery.extract_json_document``
   reads it out of a fence or prose; a model that answered with a fenced code
   block instead gets that block as the snippet.

``context_used`` in the result is what this runner actually read, not what the
model says it looked at.

Protocol (stdout, one line each):

``__STATUS__:<code>``     ``context`` | ``generating`` | ``parsing``
``__DELTA__:<json chunk>`` raw model text as it arrives
``__SNIPPET__:<json>``     ``{"snippet", "language", "description",
                          "context_used", "adaptations", "reasoning"}``
``__ERROR__:<json>``       ``{"message", "code"}`` — then exit 1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

# Add the backend package root to the path (mirrors the other runners).
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.project_brief import IGNORED_TOP_LEVEL, build_project_brief, read_head

STATUS_MARKER = "__STATUS__:"
DELTA_MARKER = "__DELTA__:"
RESULT_MARKER = "__SNIPPET__:"
ERROR_MARKER = "__ERROR__:"

SNIPPET_TYPES = ("component", "function", "class", "hook", "utility", "api", "test")

# Language id → source extensions. The ids are the dialog's own values.
LANGUAGE_EXTENSIONS: dict[str, tuple[str, ...]] = {
    "typescript": (".ts", ".tsx"),
    "javascript": (".js", ".jsx", ".mjs", ".cjs"),
    "python": (".py",),
    "java": (".java",),
    "csharp": (".cs",),
    "cpp": (".cpp", ".cc", ".cxx", ".hpp", ".hh", ".h"),
    "go": (".go",),
    "rust": (".rs",),
    "php": (".php",),
    "ruby": (".rb",),
    "kotlin": (".kt",),
    "swift": (".swift",),
    "dart": (".dart",),
}
LANGUAGE_ALIASES: dict[str, str] = {
    "ts": "typescript",
    "js": "javascript",
    "py": "python",
    "c#": "csharp",
    "cs": "csharp",
    "c++": "cpp",
    "golang": "go",
    "rb": "ruby",
    "kt": "kotlin",
    "tsx": "typescript",
    "jsx": "javascript",
}
# A component or a hook is front-end code: in a monorepo whose backend has more
# files than its UI, the most frequent language is the wrong answer for them.
FRONTEND_LANGUAGES = ("typescript", "javascript")
COMPONENT_EXTENSIONS = (".vue", ".svelte")

# Formatter and linter configuration a project declares at its root. Their
# presence is a fact about the house style; the short, purely stylistic ones are
# also excerpted.
STYLE_CONFIG_FILES = (
    ".editorconfig",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
    "prettier.config.js",
    "prettier.config.mjs",
    "biome.json",
    "biome.jsonc",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.cjs",
    "eslint.config.js",
    "eslint.config.mjs",
    "ruff.toml",
    ".ruff.toml",
    ".flake8",
    ".pylintrc",
    ".rubocop.yml",
    ".clang-format",
    "rustfmt.toml",
    ".rustfmt.toml",
    ".golangci.yml",
    ".golangci.yaml",
    "stylecop.json",
    ".swiftlint.yml",
    "analysis_options.yaml",
    "phpcs.xml",
)
EXCERPTED_STYLE_FILES = (
    ".editorconfig",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
)
STYLE_EXCERPT = 600

# The sample file: big enough to show a style, small enough to read in full.
SAMPLE_EXCERPT = 2500
SAMPLE_MIN_BYTES = 200
SAMPLE_MAX_BYTES = 60_000
SAMPLE_TARGET_BYTES = 3000
MAX_LISTED_FILES = 5000
GIT_TIMEOUT = 5

# Path segments that mean "not written by this team" or "not code".
EXCLUDED_SEGMENTS = IGNORED_TOP_LEVEL | {
    "vendor",
    "third_party",
    "third-party",
    "generated",
    "__generated__",
    "migrations",
    "fixtures",
    "snapshots",
    "__snapshots__",
    "target",
    ".git",
}
SENSITIVE_NAME = re.compile(r"secret|credential|password|\.env", re.IGNORECASE)
# A test, by directory or by the naming conventions of each ecosystem. The
# class-name suffixes are case-sensitive on purpose: `Latest.cs` is not a test.
TEST_DIR = re.compile(r"(^|/)(tests?|__tests__|specs?)/", re.IGNORECASE)
TEST_NAME = re.compile(
    r"(?:test_.*|.*[._-](?:test|spec)\.[^.]+|.*[a-z0-9](?:Tests?|Spec)\.(?:cs|java|kt))$"
)
TYPE_HINTS: dict[str, re.Pattern[str]] = {
    "component": re.compile(r"(^|/)(components?|ui|views?|widgets?)/", re.IGNORECASE),
    "hook": re.compile(r"(^|/)(hooks/|use[A-Z][^/]*$)"),
    "api": re.compile(
        r"(^|/)(api|routes?|routers?|controllers?|handlers?|endpoints?)(/|[._-])",
        re.IGNORECASE,
    ),
    "utility": re.compile(r"(^|/)(utils?|helpers?|lib|common|shared)/", re.IGNORECASE),
    "function": re.compile(r"(^|/)(utils?|helpers?|lib|services?)/", re.IGNORECASE),
    "class": re.compile(r"(^|/)(models?|services?|domain|entities)/", re.IGNORECASE),
}

TYPE_GUIDANCE: dict[str, str] = {
    "component": (
        "A UI component, in the project's UI framework, with its props/inputs typed "
        "the way the project types them."
    ),
    "function": "A single reusable function with typed parameters and return value.",
    "class": "A class with the members the description needs, and nothing more.",
    "hook": (
        "A custom hook (React's use* convention, or the framework's equivalent), "
        "with its state and effects."
    ),
    "utility": "A pure utility: no side effects, no I/O, easy to test.",
    "api": (
        "An API endpoint or handler in the project's server framework, with input "
        "validation and error handling the way the project does them."
    ),
    "test": (
        "A test written with the project's own test framework and assertion style, "
        "covering the nominal case and the edge cases the description implies."
    ),
}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def _emit(marker: str, payload: str) -> None:
    print(marker + payload, flush=True)


def emit_status(code: str) -> None:
    _emit(STATUS_MARKER, code)


def emit_error(message: str, code: str = "generic") -> None:
    _emit(ERROR_MARKER, json.dumps({"message": message, "code": code}))


# ---------------------------------------------------------------------------
# Project context
# ---------------------------------------------------------------------------


@dataclass
class SnippetContext:
    """What the model is told, and what it was built from."""

    text: str
    language: str
    language_source: str  # "user" | "detected" | "default"
    sources: list[str] = field(default_factory=list)


def normalize_language(value: str | None) -> str:
    cleaned = (value or "").strip().lower()
    return LANGUAGE_ALIASES.get(cleaned, cleaned)


def _excluded(relative: str) -> bool:
    parts = relative.split("/")
    if any(part in EXCLUDED_SEGMENTS for part in parts[:-1]):
        return True
    name = parts[-1]
    return (
        ".min." in name or name.endswith(".d.ts") or bool(SENSITIVE_NAME.search(name))
    )


def list_project_files(project_dir: Path) -> list[str]:
    """The project's files as POSIX paths relative to its root, bounded.

    ``git ls-files`` first: it is fast on any size of repository and already
    leaves out what the project ignores. A bounded walk otherwise.
    """
    try:
        from core.git_executable import run_git

        result = run_git(["ls-files", "-z"], cwd=project_dir, timeout=GIT_TIMEOUT)
        if result.returncode == 0 and result.stdout:
            files = [f for f in result.stdout.split("\0") if f]
            return [f for f in files if not _excluded(f)][:MAX_LISTED_FILES]
    except Exception:  # noqa: BLE001 — fall back to the walk
        pass

    found: list[str] = []
    for root, dirs, names in os.walk(project_dir):
        dirs[:] = sorted(
            d for d in dirs if d not in EXCLUDED_SEGMENTS and not d.startswith(".")
        )
        rel_root = Path(root).relative_to(project_dir).as_posix()
        for name in sorted(names):
            relative = name if rel_root == "." else f"{rel_root}/{name}"
            if not _excluded(relative):
                found.append(relative)
            if len(found) >= MAX_LISTED_FILES:
                return found
    return found


def _extension_of(path: str) -> str:
    dot = path.rfind(".")
    slash = path.rfind("/")
    return path[dot:].lower() if dot > slash else ""


def _language_counts(files: list[str]) -> Counter[str]:
    by_extension: dict[str, str] = {}
    for language, extensions in LANGUAGE_EXTENSIONS.items():
        for extension in extensions:
            by_extension.setdefault(extension, language)
    counts: Counter[str] = Counter()
    for path in files:
        language = by_extension.get(_extension_of(path))
        if language:
            counts[language] += 1
    return counts


def detect_language(files: list[str], snippet_type: str) -> str | None:
    """The project's language for this kind of snippet, from its files."""
    counts = _language_counts(files)
    if not counts:
        return None
    if snippet_type in ("component", "hook"):
        frontend = [(counts[lang], lang) for lang in FRONTEND_LANGUAGES if counts[lang]]
        if frontend:
            return max(frontend)[1]
    return counts.most_common(1)[0][0]


def _sample_extensions(language: str, snippet_type: str) -> tuple[str, ...]:
    extensions = LANGUAGE_EXTENSIONS.get(language, ())
    if snippet_type == "component" and language in FRONTEND_LANGUAGES:
        extensions = extensions + COMPONENT_EXTENSIONS
    return extensions


def pick_sample(
    project_dir: Path, files: list[str], language: str, snippet_type: str
) -> str | None:
    """One existing file of the target language that resembles what is asked.

    Tests are only taken as a sample for a test; anything else would teach the
    model the test style. Among the candidates, the ones whose path matches
    the kind of snippet come first, then the one closest to a readable size.
    """
    extensions = _sample_extensions(language, snippet_type)
    if not extensions:
        return None
    hint = TYPE_HINTS.get(snippet_type)
    best: tuple[int, int, str] | None = None
    for relative in files:
        if _extension_of(relative) not in extensions:
            continue
        is_test = bool(
            TEST_DIR.search(relative) or TEST_NAME.match(relative.rsplit("/", 1)[-1])
        )
        if is_test != (snippet_type == "test"):
            continue
        try:
            size = (project_dir / relative).stat().st_size
        except OSError:
            continue
        if not SAMPLE_MIN_BYTES <= size <= SAMPLE_MAX_BYTES:
            continue
        matches = 0 if hint is not None and hint.search(relative) else 1
        key = (matches, abs(size - SAMPLE_TARGET_BYTES), relative)
        if best is None or key < best:
            best = key
    return best[2] if best else None


def _has_secret(text: str, label: str) -> bool:
    """True when the scanner flags ``text`` — or cannot load: "could not check"
    must not read as "nothing to hide"."""
    try:
        from security.scan_secrets import scan_content

        return bool(scan_content(text, label))
    except Exception:  # noqa: BLE001 — fail closed
        return True


def _style_section(project_dir: Path) -> tuple[str, list[str]]:
    present = [name for name in STYLE_CONFIG_FILES if (project_dir / name).is_file()]
    if not present:
        return "", []
    lines = ["Formatter / linter configuration present: " + ", ".join(present)]
    for name in EXCERPTED_STYLE_FILES:
        if name in present:
            excerpt = read_head(project_dir / name, STYLE_EXCERPT)
            if excerpt and not _has_secret(excerpt, name):
                lines.append(f"Excerpt of {name}:\n{excerpt}")
    return "\n\n".join(lines), present


def gather_snippet_context(
    project_dir: Path, snippet_type: str, language: str | None
) -> SnippetContext:
    """The project brief, its declared style, and one file of its own code."""
    brief = build_project_brief(project_dir)
    files = list_project_files(project_dir)

    target = normalize_language(language)
    source = "user"
    if not target:
        target = detect_language(files, snippet_type) or ""
        source = "detected" if target else "default"

    sections = [brief.text]
    sources = list(brief.stack) + list(brief.files)

    style, style_files = _style_section(project_dir)
    if style:
        sections.append(style)
        sources.extend(style_files)

    sample = pick_sample(project_dir, files, target, snippet_type) if target else None
    if sample:
        excerpt = read_head(project_dir / sample, SAMPLE_EXCERPT)
        if excerpt and not _has_secret(excerpt, sample):
            sections.append(
                f'<code_sample path="{sample}">\n{excerpt}\n</code_sample>\n'
                "An existing file of this project: follow its naming, imports, "
                "formatting, comments and error handling. Do not copy its logic."
            )
            sources.append(sample)

    unique: list[str] = []
    for item in sources:
        if item and item not in unique:
            unique.append(item)
    return SnippetContext(
        text="\n\n".join(sections),
        language=target,
        language_source=source,
        sources=unique,
    )


# ---------------------------------------------------------------------------
# Prompting
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior engineer on the project described below. You write
a code snippet that reads as if the project's own team had written it.

Rules:
- Write exactly what the description asks for, as the requested kind of
  snippet. Do not add features nobody asked for.
- Follow the project's conventions wherever the context shows them: the code
  sample's naming, imports, formatting (indentation, quotes, semicolons),
  comments and error handling; the formatter configuration; the libraries of the
  detected stack. Do not import a library the project does not show.
- Do not copy the sample's logic; it is there for its style.
- When something essential is unknown, choose the simplest option consistent
  with the project and say so in "reasoning".
- Write "description", "adaptations" and "reasoning" in the same language as
  the user's description.

Answer with ONE JSON object and nothing else:
{
  "snippet": "the complete code, as a JSON string (newlines escaped), without a Markdown fence",
  "language": "the language of the snippet",
  "description": "one sentence: what the snippet does",
  "adaptations": ["one entry per way the snippet follows this project's conventions"],
  "reasoning": "two or three sentences on the choices made"
}"""


def build_user_prompt(
    snippet_type: str, description: str, context: SnippetContext
) -> str:
    guidance = TYPE_GUIDANCE.get(snippet_type, "")
    if context.language and context.language_source == "user":
        language = f"Target language: {context.language} (chosen by the user)"
    elif context.language:
        language = (
            f"Target language: {context.language} (detected from the project's files)"
        )
    else:
        language = "Target language: the project's main language, from the context"
    return (
        f"Snippet type: {snippet_type} — {guidance}\n{language}\n\n"
        f"<project_context>\n{context.text}\n</project_context>\n\n"
        f"<description>\n{description}\n</description>"
    )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

FENCE = re.compile(r"```[ \t]*([\w#+.-]*)[^\n]*\n(.*?)\n?```", re.DOTALL)


def _strip_fence(text: str) -> str:
    fenced = re.fullmatch(r"\s*```[^\n]*\n(.*?)\n?```\s*", text, re.DOTALL)
    return (fenced.group(1) if fenced else text).strip("\n").rstrip()


def _strings(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def parse_response(text: str, *, language: str, description: str) -> dict | None:
    """The model's answer as the result fields the dialog reads, or None.

    ``context_used`` is not taken from the model: the caller fills it with what
    was actually read.
    """
    text = (text or "").strip()
    if not text:
        return None

    from spec.plan_recovery import extract_json_document

    data = extract_json_document(text)
    if isinstance(data, dict):
        snippet = data.get("snippet")
        if isinstance(snippet, str) and snippet.strip():
            return {
                "snippet": _strip_fence(snippet),
                "language": normalize_language(str(data.get("language") or ""))
                or language,
                "description": str(data.get("description") or "").strip()
                or description,
                "adaptations": _strings(data.get("adaptations")),
                "reasoning": str(data.get("reasoning") or "").strip(),
            }

    fenced = FENCE.search(text)
    if fenced and fenced.group(2).strip():
        return {
            "snippet": fenced.group(2).rstrip(),
            "language": normalize_language(fenced.group(1)) or language,
            "description": description,
            "adaptations": [],
            "reasoning": "",
        }

    # Bare code with no fence: still the snippet. A broken JSON object is not.
    if not text.startswith(("{", "[")):
        return {
            "snippet": text,
            "language": language,
            "description": description,
            "adaptations": [],
            "reasoning": "",
        }
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _read_description(args: argparse.Namespace) -> str:
    if args.description_file:
        return Path(args.description_file).read_text(encoding="utf-8")
    return args.description or ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate a context-aware code snippet"
    )
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--snippet-type", required=True, choices=SNIPPET_TYPES)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--description", help="What the snippet should do")
    source.add_argument(
        "--description-file",
        help="UTF-8 file holding the description (no command-line length or "
        "leading-dash limits)",
    )
    parser.add_argument("--language", help="Target language; detected when omitted")
    parser.add_argument("--model", help="Model id; defaults to the provider's own")
    parser.add_argument("--thinking-level", help="Accepted for parity; unused")
    args = parser.parse_args(argv)

    project_dir = Path(args.project_dir)
    if not project_dir.is_dir():
        emit_error(f"Project directory not found: {project_dir}", "project_not_found")
        return 1

    try:
        description = _read_description(args).strip()
    except OSError as exc:
        emit_error(f"Could not read the description: {exc}", "invalid_input")
        return 1
    if not description:
        emit_error("The description is empty.", "empty_description")
        return 1

    emit_status("context")
    context = gather_snippet_context(project_dir, args.snippet_type, args.language)

    emit_status("generating")
    errors: list[dict] = []

    def on_delta(chunk: str) -> None:
        _emit(DELTA_MARKER, json.dumps(chunk))

    try:
        from core.oneshot import oneshot_completion

        text = asyncio.run(
            oneshot_completion(
                build_user_prompt(args.snippet_type, description, context),
                system_prompt=SYSTEM_PROMPT,
                model=args.model or None,
                project_dir=str(project_dir),
                max_turns=1,
                on_delta=on_delta,
                on_error=errors.append,
            )
        )
    except Exception as exc:  # noqa: BLE001 — the dialog needs a sentence, not a trace
        emit_error(f"{type(exc).__name__}: {exc}", "provider_error")
        return 1

    if not text:
        detail = errors[-1] if errors else {}
        emit_error(
            str(detail.get("message") or "The model returned an empty answer."),
            str(detail.get("code") or "empty_response"),
        )
        return 1

    emit_status("parsing")
    result = parse_response(text, language=context.language, description=description)
    if result is None:
        emit_error(
            "The model's answer holds neither a JSON object nor a code block.",
            "invalid_response",
        )
        return 1

    result["context_used"] = context.sources
    _emit(RESULT_MARKER, json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

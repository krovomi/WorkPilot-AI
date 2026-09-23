#!/usr/bin/env python3
"""
Prompt Optimizer Runner — rewrites a user prompt for a coding agent.

The Kanban's task form and the sidebar's "Optimiseur de Prompts IA" spawn this
runner through ``prompt-optimizer-service.ts``. It did not exist: the service
looked for it, found nothing, and the dialog could only ever answer
"prompt_optimizer_runner.py not found".

What it does, in three steps:

1. **Project context, without a model.** The stack the security profile
   already cached (``.workpilot-security.json``), else the manifests at the
   project root; the top-level layout; and the head of the files that carry the
   project's own rules (``AGENTS.md``, ``CLAUDE.md``, ``README.md``). Bounded,
   read-only, no recursive walk: the dialog is waiting on it.
2. **One completion, on whatever provider the page resolved.** Through
   ``core.oneshot.oneshot_completion`` — the same provider-agnostic path the
   Arena uses — so ``SELECTED_LLM_PROVIDER`` (set by the Electron side from the
   page's own choice or the global "Fournisseur IA" list) is honoured.
3. **A tagged answer, parsed leniently.** The model is asked for
   ``<optimized_prompt>``, ``<changes>`` and ``<reasoning>`` sections rather
   than JSON: an optimized prompt is long prose full of quotes and code, which
   is exactly what a model gets wrong inside a JSON string. Tags also let the
   UI show the prompt forming while it streams.

Protocol (stdout, one line each):

``__STATUS__:<code>``                 ``context`` | ``generating`` | ``parsing``
``__DELTA__:<json chunk>``            raw model text as it arrives
``__OPTIMIZED_PROMPT__:<json>``       ``{"optimized", "changes", "reasoning"}``
``__ERROR__:<json>``                  ``{"message", "code"}`` — then exit 1
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

# Add the backend package root to the path (mirrors the other runners).
sys.path.insert(0, str(Path(__file__).parent.parent))

STATUS_MARKER = "__STATUS__:"
DELTA_MARKER = "__DELTA__:"
RESULT_MARKER = "__OPTIMIZED_PROMPT__:"
ERROR_MARKER = "__ERROR__:"

AGENT_TYPES = ("general", "analysis", "coding", "verification")

# Total budget for the project context handed to the model. The prompt being
# optimized is the subject; the context is there to make it specific, not to
# drown it.
CONTEXT_BUDGET = 6000
DOC_EXCERPT = 1800
MAX_TOP_LEVEL_ENTRIES = 40

# Files whose head carries the project's own conventions, in reading order.
CONVENTION_FILES = ("AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md")
README_FILES = ("README.md", "README.rst", "README.txt", "README")

# Root-level manifests → the stack they reveal. Read at the root only: a
# recursive glob on a monorepo with node_modules costs seconds the dialog is
# spending on a spinner.
MANIFEST_HINTS: dict[str, str] = {
    "package.json": "JavaScript/TypeScript (npm)",
    "tsconfig.json": "TypeScript",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "setup.py": "Python",
    "go.mod": "Go",
    "Cargo.toml": "Rust",
    "pom.xml": "Java (Maven)",
    "build.gradle": "JVM (Gradle)",
    "build.gradle.kts": "Kotlin (Gradle)",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pubspec.yaml": "Dart/Flutter",
    "Package.swift": "Swift",
    "global.json": ".NET",
    "Directory.Build.props": ".NET",
}
MANIFEST_SUFFIXES: dict[str, str] = {
    ".sln": ".NET (solution)",
    ".slnx": ".NET (solution)",
    ".csproj": "C# (.NET)",
    ".fsproj": "F# (.NET)",
}

IGNORED_TOP_LEVEL = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    ".idea",
    ".vs",
    ".vscode",
    ".next",
    ".turbo",
    "coverage",
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


def _read_head(path: Path, limit: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    text = text.strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    # End on a line boundary so the excerpt does not stop mid-sentence.
    newline = cut.rfind("\n")
    if newline > limit // 2:
        cut = cut[:newline]
    return cut.rstrip() + "\n[…]"


def _cached_stack(project_dir: Path) -> list[str]:
    """The stack the security profile already detected, if it is on disk.

    Read-only on purpose: ``get_or_create_profile`` would analyse the whole
    tree and write the profile into the user's project, which is not what
    opening a dialog should do.
    """
    try:
        from project.analyzer import ProjectAnalyzer

        profile = ProjectAnalyzer(project_dir).load_profile()
    except Exception:  # noqa: BLE001 — context is best-effort
        return []
    if profile is None:
        return []
    stack = profile.detected_stack
    items: list[str] = []
    for group in (stack.languages, stack.frameworks, stack.databases):
        for item in group:
            if item not in items:
                items.append(item)
    return items


def _manifest_stack(project_dir: Path) -> list[str]:
    found: list[str] = []
    try:
        entries = list(project_dir.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.is_file():
            continue
        hint = MANIFEST_HINTS.get(entry.name) or MANIFEST_SUFFIXES.get(entry.suffix)
        if hint and hint not in found:
            found.append(hint)
    return found


def _top_level_layout(project_dir: Path) -> list[str]:
    try:
        entries = sorted(project_dir.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return []
    layout: list[str] = []
    for entry in entries:
        if entry.name in IGNORED_TOP_LEVEL:
            continue
        if entry.name.startswith(".") and entry.name not in (".github", ".workpilot"):
            continue
        layout.append(entry.name + ("/" if entry.is_dir() else ""))
        if len(layout) >= MAX_TOP_LEVEL_ENTRIES:
            layout.append("…")
            break
    return layout


def gather_project_context(project_dir: Path) -> str:
    """Everything the model is told about the project, as one bounded block."""
    sections: list[str] = [f"Project name: {project_dir.name}"]

    stack = _cached_stack(project_dir) or _manifest_stack(project_dir)
    if stack:
        sections.append("Detected stack: " + ", ".join(stack))

    layout = _top_level_layout(project_dir)
    if layout:
        sections.append("Top-level layout: " + ", ".join(layout))

    for name in CONVENTION_FILES:
        path = project_dir / name
        if path.is_file():
            excerpt = _read_head(path, DOC_EXCERPT)
            if excerpt:
                sections.append(f"Excerpt of {name} (project conventions):\n{excerpt}")

    for name in README_FILES:
        path = project_dir / name
        if path.is_file():
            excerpt = _read_head(path, DOC_EXCERPT)
            if excerpt:
                sections.append(f"Excerpt of {name}:\n{excerpt}")
            break

    context = "\n\n".join(sections)
    if len(context) > CONTEXT_BUDGET:
        context = context[:CONTEXT_BUDGET].rstrip() + "\n[…]"
    return context


# ---------------------------------------------------------------------------
# Prompting
# ---------------------------------------------------------------------------

AGENT_GUIDANCE: dict[str, str] = {
    "general": (
        "The prompt will be handed to a general-purpose AI coding agent. Make the "
        "goal, the scope and the expected output unambiguous."
    ),
    "analysis": (
        "The prompt will be handed to an agent that ANALYSES or REVIEWS code "
        "without changing it. Name what to inspect, the questions to answer, the "
        "criteria to judge by, and the shape of the report expected (findings "
        "ranked by severity, with file references)."
    ),
    "coding": (
        "The prompt will be handed to an agent that IMPLEMENTS code. State the "
        "functional goal, the constraints (stack, conventions, files or layers "
        "likely involved), what must not change, and acceptance criteria that can "
        "be verified (tests, observable behaviour)."
    ),
    "verification": (
        "The prompt will be handed to an agent that TESTS and VERIFIES (QA). State "
        "what must be proven, the scenarios including edge cases and failure "
        "paths, how to run the checks, and what counts as pass or fail."
    ),
}

SYSTEM_PROMPT = """You are an expert prompt engineer for autonomous AI coding agents.
You rewrite a user's prompt so an agent working in the given project can act on
it without guessing.

Rules:
- Preserve the user's intent exactly. Never add features, requirements or scope
  the user did not ask for; clarify, structure and make specific.
- Write the optimized prompt in the SAME LANGUAGE as the user's prompt.
- Use the project context only where it makes the prompt more precise (stack,
  conventions, likely locations). Do not paste the context back.
- When something essential is genuinely unknown, keep it as an explicit
  assumption or open question inside the prompt rather than inventing an answer.
- Prefer a clear structure (short sections or bullet lists: Goal, Context,
  Requirements, Constraints, Acceptance criteria) when the prompt is more than a
  sentence or two; keep a simple request simple.
- The optimized prompt is addressed to the agent, not to the user.

Answer with EXACTLY these three tagged sections and nothing else:

<optimized_prompt>
the rewritten prompt, ready to paste
</optimized_prompt>
<changes>
- one line per improvement you made, in the user's language
</changes>
<reasoning>
two or three sentences, in the user's language, on why these changes help the agent
</reasoning>"""


def build_user_prompt(prompt: str, agent_type: str, context: str) -> str:
    guidance = AGENT_GUIDANCE.get(agent_type, AGENT_GUIDANCE["general"])
    return (
        f"Target agent: {agent_type}\n{guidance}\n\n"
        f"<project_context>\n{context}\n</project_context>\n\n"
        f"<user_prompt>\n{prompt}\n</user_prompt>"
    )


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _section(text: str, tag: str) -> str | None:
    """Content of ``<tag>…</tag>``; an unclosed tag runs to the next tag or the end."""
    match = re.search(rf"<{tag}>\s*(.*?)\s*</{tag}>", text, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip()
    opened = re.search(rf"<{tag}>\s*", text, re.IGNORECASE)
    if not opened:
        return None
    rest = text[opened.end() :]
    next_tag = re.search(r"\n?<(optimized_prompt|changes|reasoning)>", rest)
    if next_tag:
        rest = rest[: next_tag.start()]
    return rest.strip()


def _strip_fence(text: str) -> str:
    fenced = re.fullmatch(r"```[\w-]*\n(.*?)\n```", text.strip(), re.DOTALL)
    return fenced.group(1).strip() if fenced else text


def _bullets(text: str | None) -> list[str]:
    if not text:
        return []
    items: list[str] = []
    for line in text.splitlines():
        cleaned = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s+", "", line).strip()
        if cleaned:
            items.append(cleaned)
    return items


def parse_response(text: str) -> dict | None:
    """The model's answer as ``{"optimized", "changes", "reasoning"}``, or None.

    A model that ignored the tags entirely still produced *a* rewrite: it is
    returned as the optimized prompt with no listed changes, rather than
    thrown away. Only an empty answer is a failure.
    """
    text = (text or "").strip()
    if not text:
        return None

    optimized = _section(text, "optimized_prompt")
    changes = _bullets(_section(text, "changes"))
    reasoning = _section(text, "reasoning") or ""

    if optimized is None:
        # No tags: the whole answer is the rewrite, minus a JSON attempt.
        try:
            data = json.loads(_strip_fence(text))
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and isinstance(data.get("optimized"), str):
            raw_changes = data.get("changes")
            return {
                "optimized": data["optimized"].strip(),
                "changes": [str(c) for c in raw_changes]
                if isinstance(raw_changes, list)
                else [],
                "reasoning": str(data.get("reasoning") or ""),
            }
        optimized = text

    optimized = _strip_fence(optimized)
    if not optimized:
        return None
    return {"optimized": optimized, "changes": changes, "reasoning": reasoning}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _read_prompt(args: argparse.Namespace) -> str:
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8")
    return args.prompt or ""


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI prompt optimizer")
    parser.add_argument("--project-dir", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--prompt", help="The prompt to optimize")
    source.add_argument(
        "--prompt-file",
        help="UTF-8 file holding the prompt (avoids command-line length limits)",
    )
    parser.add_argument("--agent-type", default="general", choices=AGENT_TYPES)
    parser.add_argument("--model", help="Model id; defaults to the provider's own")
    parser.add_argument("--thinking-level", help="Accepted for parity; unused")
    args = parser.parse_args(argv)

    project_dir = Path(args.project_dir)
    if not project_dir.is_dir():
        emit_error(f"Project directory not found: {project_dir}", "project_not_found")
        return 1

    try:
        prompt = _read_prompt(args).strip()
    except OSError as exc:
        emit_error(f"Could not read the prompt: {exc}", "invalid_input")
        return 1
    if not prompt:
        emit_error("The prompt is empty.", "empty_prompt")
        return 1

    emit_status("context")
    context = gather_project_context(project_dir)

    emit_status("generating")
    errors: list[dict] = []

    def on_delta(chunk: str) -> None:
        _emit(DELTA_MARKER, json.dumps(chunk))

    try:
        from core.oneshot import oneshot_completion

        text = asyncio.run(
            oneshot_completion(
                build_user_prompt(prompt, args.agent_type, context),
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
    result = parse_response(text)
    if result is None:
        emit_error("The model returned an empty answer.", "empty_response")
        return 1

    _emit(RESULT_MARKER, json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())

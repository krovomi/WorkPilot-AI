"""
Incremental Code Analyzer for the Live Companion.

Analyzes what just changed in a file (its diff, or the head of a new or
untracked file) to detect potential bugs, missing updates, convention
mismatches and refactoring opportunities.

The model call goes through ``core.oneshot.oneshot_completion``: single turn,
text only, on the provider the user selected (Claude, Copilot, OpenAI, Gemini,
Mistral, DeepSeek, Grok, local models…) with that provider's cheap default
model. The changed code comes from the user's repository, so it enters the
prompt quoted as data (``security.untrusted.quote_untrusted``, rule S2).

A provider failure raises :class:`AnalysisError` instead of passing for "no
suggestion": the companion used to swallow every error (it even imported a
module that does not exist) and the page stayed empty forever.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .types import (
    FileChangeEvent,
    LiveSuggestion,
    SuggestionPriority,
    SuggestionType,
)

logger = logging.getLogger(__name__)

# What the companion reads of one change: enough for a function or two, small
# enough that a burst of saves stays cheap.
MAX_CHANGE_CHARS = 4000

DEFAULT_MIN_CONFIDENCE = 0.5
DEFAULT_MAX_PER_FILE = 5

SYSTEM_PROMPT = (
    "You are a real-time code review companion. You read one change a "
    "developer just made and answer with a JSON array only, no prose."
)

ANALYSIS_PROMPT = """\
A developer just changed a file. Analyze the change and produce actionable suggestions.

## File
- Path: {file_path}
- Language: {language}
- Change type: {change_type}

## Change ({content_kind})
{change}

## What to look for
1. Bugs: null dereferences, race conditions, off-by-one errors, unhandled errors
2. Missing updates: an interface, contract or schema changed without its implementations, callers or migration
3. Security: injection, hard-coded secrets, unsafe operations
4. Performance: N+1 queries, needless re-renders or allocations, blocking calls
5. Conventions that diverge from the language or framework idioms
6. Logic changed without a test
7. Code that re-implements an existing utility

## Answer
A JSON array (empty `[]` when nothing is worth saying). Each item:
{{
  "suggestion_type": "bug_detection|duplicate_code|missing_update|contract_violation|performance_issue|security_issue|missing_test|refactor_opportunity|import_suggestion|convention_mismatch|general",
  "priority": "critical|high|medium|low|info",
  "title": "short title",
  "description": "what the issue is and why it matters",
  "line_start": 0,
  "line_end": 0,
  "code_fix": "optional replacement snippet",
  "related_files": ["other paths that may need the same change"],
  "confidence": 0.0
}}

Only include suggestions with confidence >= {min_confidence}, at most {max_per_file}.
Write "title" and "description" in {answer_language}. Keep code, identifiers and paths as they are.
Be specific and concise: the developer reads these while coding.
"""

_ANSWER_LANGUAGES = {"fr": "French", "en": "English"}

# Extension → language, for every stack the app supports (frontend, backend,
# mobile, scripting). The main process sends its own label; this is the
# fallback when it does not.
_LANGUAGES = {
    ".ts": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    ".tsx": "TypeScript (React)",
    ".js": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".jsx": "JavaScript (React)",
    ".vue": "Vue",
    ".svelte": "Svelte",
    ".astro": "Astro",
    ".html": "HTML",
    ".css": "CSS",
    ".scss": "SCSS",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".java": "Java",
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    ".scala": "Scala",
    ".groovy": "Groovy",
    ".cs": "C#",
    ".fs": "F#",
    ".vb": "Visual Basic",
    ".razor": "Razor (Blazor)",
    ".cshtml": "Razor",
    ".swift": "Swift",
    ".m": "Objective-C",
    ".dart": "Dart",
    ".rb": "Ruby",
    ".php": "PHP",
    ".c": "C",
    ".h": "C/C++ header",
    ".cpp": "C++",
    ".cc": "C++",
    ".hpp": "C++",
    ".ex": "Elixir",
    ".exs": "Elixir",
    ".erl": "Erlang",
    ".lua": "Lua",
    ".r": "R",
    ".jl": "Julia",
    ".zig": "Zig",
    ".sql": "SQL",
    ".sh": "Shell",
    ".ps1": "PowerShell",
}


class AnalysisError(RuntimeError):
    """The provider could not analyze a change; ``detail`` says why.

    ``detail`` is the redacted ``ErrorDetail.to_dict()`` payload the one-shot
    helper reports (``message``, ``code``, sometimes ``provider``/``model``).
    """

    def __init__(self, detail: dict[str, Any]) -> None:
        super().__init__(str(detail.get("message") or "analysis failed"))
        self.detail = detail


def detect_language(file_path: str) -> str:
    """The language of `file_path` from its extension, or ``Unknown``."""
    return _LANGUAGES.get(Path(file_path).suffix.lower(), "Unknown")


class IncrementalAnalyzer:
    """Analyzes file changes incrementally to generate real-time suggestions."""

    def __init__(
        self,
        project_dir: str | Path,
        model: str | None = None,
        thinking_level: str | None = None,
        *,
        min_confidence: float = DEFAULT_MIN_CONFIDENCE,
        max_per_file: int = DEFAULT_MAX_PER_FILE,
        language: str = "en",
    ):
        self.project_dir = Path(project_dir)
        # None = the selected provider's default model; a Claude alias here
        # would be sent to Mistral or Copilot as is.
        self.model = model or None
        self.thinking_level = thinking_level or "low"
        self.min_confidence = min(max(float(min_confidence), 0.0), 1.0)
        self.max_per_file = max(int(max_per_file), 1)
        self.answer_language = _ANSWER_LANGUAGES.get(
            (language or "en").split("-")[0].lower(), "English"
        )

    async def analyze_change(
        self,
        event: FileChangeEvent,
        project_context: str = "",
    ) -> list[LiveSuggestion]:
        """Analyze a file change and return suggestions.

        Returns ``[]`` when there is nothing to read (a deletion, an empty
        diff). Raises :class:`AnalysisError` when the provider fails.
        """
        if event.change_type == "deleted" or not event.diff.strip():
            return []

        prompt = self.build_prompt(event)
        response = await self._call_ai(prompt)
        return self._parse_suggestions(response, event.file_path)

    def build_prompt(self, event: FileChangeEvent) -> str:
        from security.untrusted import quote_untrusted

        is_diff = event.content_kind == "diff"
        change = quote_untrusted(
            event.diff[:MAX_CHANGE_CHARS],
            kind="diff" if is_diff else "file_content",
            source=f"live companion: {event.file_path}",
        )
        return ANALYSIS_PROMPT.format(
            file_path=event.file_path,
            language=event.language
            if event.language and event.language != "Unknown"
            else detect_language(event.file_path),
            change_type=event.change_type,
            content_kind="git diff" if is_diff else "start of the file",
            change=change,
            min_confidence=self.min_confidence,
            max_per_file=self.max_per_file,
            answer_language=self.answer_language,
        )

    async def _call_ai(self, prompt: str) -> str:
        """One single-turn completion on the user's provider."""
        from core.oneshot import oneshot_completion

        errors: list[dict[str, Any]] = []
        text = await oneshot_completion(
            prompt,
            system_prompt=SYSTEM_PROMPT,
            model=self.model,
            project_dir=str(self.project_dir),
            max_turns=1,
            on_error=errors.append,
            thinking_level=self.thinking_level,
        )
        if not text or not text.strip():
            detail = errors[-1] if errors else {}
            raise AnalysisError(
                {
                    **detail,
                    "message": str(
                        detail.get("message") or "The model returned an empty answer."
                    ),
                    "code": str(detail.get("code") or "empty_response"),
                }
            )
        return text

    def _parse_suggestions(self, response: str, file_path: str) -> list[LiveSuggestion]:
        """Parse the model's answer into suggestions, best first."""
        parsed = self._extract_json_array(response)
        if not parsed:
            return []

        suggestions: list[LiveSuggestion] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            try:
                suggestion = LiveSuggestion(
                    suggestion_id=LiveSuggestion.generate_id(),
                    suggestion_type=_enum_or(
                        SuggestionType,
                        item.get("suggestion_type"),
                        SuggestionType.GENERAL,
                    ),
                    priority=_enum_or(
                        SuggestionPriority,
                        item.get("priority"),
                        SuggestionPriority.MEDIUM,
                    ),
                    title=str(item.get("title") or "").strip(),
                    description=str(item.get("description") or "").strip(),
                    file_path=file_path,
                    line_start=max(int(item.get("line_start") or 0), 0),
                    line_end=max(int(item.get("line_end") or 0), 0),
                    code_fix=str(item.get("code_fix") or ""),
                    related_files=[
                        str(path) for path in item.get("related_files") or [] if path
                    ][:10],
                    confidence=min(max(float(item.get("confidence", 0.5)), 0.0), 1.0),
                )
            except (TypeError, ValueError) as e:
                logger.warning("Failed to parse suggestion: %s", e)
                continue
            if suggestion.title and suggestion.confidence >= self.min_confidence:
                suggestions.append(suggestion)

        suggestions.sort(key=lambda s: s.confidence, reverse=True)
        return suggestions[: self.max_per_file]

    def _extract_json_array(self, text: str) -> list[Any] | None:
        """Extract a JSON array from the model's answer."""
        if not text:
            return None

        try:
            result = json.loads(text)
            if isinstance(result, list):
                return result
        except json.JSONDecodeError:
            pass

        for marker in ("```json", "```"):
            if marker in text:
                start = text.index(marker) + len(marker)
                end = text.find("```", start)
                if end > start:
                    try:
                        result = json.loads(text[start:end].strip())
                        if isinstance(result, list):
                            return result
                    except json.JSONDecodeError:
                        pass

        first = text.find("[")
        last = text.rfind("]")
        if first >= 0 and last > first:
            try:
                result = json.loads(text[first : last + 1])
                if isinstance(result, list):
                    return result
            except json.JSONDecodeError:
                pass

        return None

    def _detect_language(self, file_path: str) -> str:
        return detect_language(file_path)


def _enum_or(enum_cls, value, default):
    """``enum_cls(value)``, or `default` when the model invented a value."""
    try:
        return enum_cls(str(value)) if value else default
    except ValueError:
        return default

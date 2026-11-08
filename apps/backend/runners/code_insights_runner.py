"""
Code Insights Runner

The desktop backend of two Development views: "Code review" (static review
of a patch) and "Refactoring" (code smells and refactoring proposals for a
pasted snippet). Both views used to fetch a relative ``/api/...`` URL from
the renderer, which never reached the backend in the packaged app.

Every stack is read: the review rules cover Python, JS/TS, .NET, JVM, Go,
Rust, Swift, PHP, Ruby, Dart and C/C++ (``review.polyglot_rules``), and the
smells come from ``ast`` for Python and from ``agents.refactorer_polyglot``
for the others. A snippet without a language is guessed from its syntax.

The request is one JSON object on stdin (the text can be large), never argv:
    {"action": "review" | "smells" | "propose" | "languages",
     "text": "...", "language": "csharp" (optional)}

Output protocol (one line each, prefixed):
    CODE_INSIGHTS_RESULT:{...}
    CODE_INSIGHTS_ERROR:<message>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agents.refactorer import RefactoringAgent  # noqa: E402
from agents.refactorer_polyglot import (  # noqa: E402
    guess_language,
    snippet_path,
    supported_languages,
)

ACTIONS = {"review", "smells", "propose", "languages"}
MAX_TEXT_BYTES = 2 * 1024 * 1024
_LANGUAGE_ID = re.compile(r"^[a-z+#]{1,20}$")


def _error(message: str) -> None:
    print(f"CODE_INSIGHTS_ERROR:{' '.join(message.split())}", flush=True)


def _language(text: str, requested: Any) -> str:
    """The request's language when it is a known id, else a guess (Python by default)."""
    known = {lang["id"] for lang in supported_languages()}
    if isinstance(requested, str) and requested in known:
        return requested
    return guess_language(text) or "python"


def _smell(raw: dict[str, Any]) -> dict[str, Any]:
    """The view's smell shape: ``line`` and ``symbol``, not the agent's field names."""
    return {
        "smell_type": raw.get("smell_type"),
        "severity": raw.get("severity"),
        "message": raw.get("message"),
        "line": raw.get("line_start"),
        "symbol": raw.get("symbol_name") or None,
        "metric_value": raw.get("metric_value"),
        "threshold": raw.get("threshold"),
    }


def _proposal(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "pattern": raw.get("pattern"),
        "description": raw.get("description"),
        "risk_level": raw.get("risk_level"),
        "symbol": raw.get("target_symbol") or None,
        "impact": raw.get("estimated_impact") or None,
    }


def handle(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action not in ACTIONS:
        raise ValueError(f"Unknown action: {action!r}")
    if action == "languages":
        return {"languages": supported_languages()}

    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("A non-empty text is required")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("Input exceeds 2 MB")

    if action == "review":
        from agent_endpoints.code_review import analyze_diff

        return analyze_diff(text)

    language = _language(text, request.get("language"))
    path = snippet_path(language)
    agent = RefactoringAgent()
    if action == "smells":
        smells = agent.detect_smells_from_source(text, path, language)
        return {"language": language, "smells": [_smell(s.to_dict()) for s in smells]}
    proposals = agent.propose_refactoring(
        source=text, file_path=path, language=language
    )
    return {
        "language": language,
        "proposals": [_proposal(p.to_dict()) for p in proposals],
    }


def main() -> None:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise ValueError("The request must be a JSON object")
        language = request.get("language")
        if language is not None and (
            not isinstance(language, str) or not _LANGUAGE_ID.match(language)
        ):
            raise ValueError("Invalid language id")
        result = handle(request)
    except (ValueError, OSError, SyntaxError, RecursionError) as exc:
        _error(str(exc))
        sys.exit(1)
    print(f"CODE_INSIGHTS_RESULT:{json.dumps(result, default=str)}", flush=True)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()

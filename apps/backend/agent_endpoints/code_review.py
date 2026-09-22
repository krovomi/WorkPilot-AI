"""Adapt the existing static reviewer to the desktop review contract."""

from typing import Any

from review.ai_code_review import AICodeReviewer


def analyze_diff(diff: str) -> dict[str, Any]:
    """Review a bounded patch, preserving original paths and line numbers."""
    if not isinstance(diff, str) or not diff.strip():
        raise ValueError("A non-empty diff is required")
    if len(diff.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("Review input exceeds 2 MB")
    result = AICodeReviewer().review_diff(diff)
    severities = {
        "critical": "critical",
        "error": "high",
        "warning": "medium",
        "suggestion": "low",
        "info": "info",
    }
    return {
        "score": result.overall_score,
        "passed": not any(
            comment.severity.value in ("critical", "error")
            for comment in result.comments
        ),
        "summary": result.summary,
        "issues": [
            {
                "rule": comment.rule_id,
                "severity": severities[comment.severity.value],
                "message": comment.message,
                "file": comment.file_path,
                "line": comment.line,
                "suggestion": comment.suggestion,
            }
            for comment in result.comments
        ],
    }

"""Two `.wpreplay` bundles side by side, as one page (#347).

The comparison of two sessions (`ReplayRecorder.compare_sessions`) shows
numbers; this page shows the two timelines next to each other, so a video
of it (``video.record_video``) plays "how the refactor went in v2 against
v1" step by step, both columns at once. It is written like the page of one
session (`viewer.py`), from bundles already masked by `bundle.build_bundle`:
no script, every text escaped, and a Content-Security-Policy that allows
only its own style sheet, by hash.
"""

from __future__ import annotations

from typing import Any

from .viewer import LABELS, STYLE, _csp, _duration, _e, _notes, _row, _step

COMPARE_LABELS: dict[str, dict[str, str]] = {
    "en": {"compare_title": "Agent replays side by side", "a": "A", "b": "B"},
    "fr": {"compare_title": "Rejeux d'agent côte à côte", "a": "A", "b": "B"},
}

COMPARE_STYLE = STYLE + (
    "main.pair{max-width:none;display:grid;grid-template-columns:1fr 1fr;gap:16px}"
    "main.pair>h1,main.pair>footer{grid-column:1/-1}"
    "section.side{min-width:0}"
)


def _column(bundle: dict[str, Any], side: str, t: dict[str, str]) -> str:
    session: dict[str, Any] = bundle["session"]
    steps: list[dict[str, Any]] = session.get("steps", [])
    marked = {b.get("step_index", 0) for b in session.get("bookmarks", [])}
    stripped = bundle.get("options", {}).get("strip_tokens")
    label = session.get("model_label") or session.get("model")
    model = " · ".join(part for part in (session.get("provider"), label) if part)
    facts = "".join(
        [
            _row(t["agent"], session.get("agent_name")),
            _row(t["model"], model),
            _row(t["task"], session.get("task_description")),
            _row(t["duration"], _duration(session.get("duration_seconds", 0))),
            _row(t["steps"], len(steps)),
            "" if stripped else _row(t["tokens"], session.get("total_tokens", 0)),
        ]
    )
    # Each column numbers its own steps: their anchors are told apart by side.
    timeline = (
        "".join(
            _step(step, marked, t).replace('id="step-', f'id="{side}-step-', 1)
            for step in steps
        )
        or f"<p class=note>{_e(t['no_steps'])}</p>"
    )
    return (
        f"<section class=side><h2>{_e(t[side])}</h2><dl>{facts}</dl>"
        f"{_notes(bundle, t)}<div class=steps>{timeline}</div></section>"
    )


def render_comparison(
    bundle_a: dict[str, Any], bundle_b: dict[str, Any], language: str = "en"
) -> str:
    """The page with ``bundle_a`` on the left and ``bundle_b`` on the right."""
    lang = language if language in LABELS else "en"
    t = {**LABELS[lang], **COMPARE_LABELS[lang]}
    return (
        f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
        f'<meta http-equiv="Content-Security-Policy" content="{_e(_csp(COMPARE_STYLE))}">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="referrer" content="no-referrer">'
        f"<title>{_e(t['compare_title'])}</title><style>{COMPARE_STYLE}</style></head>"
        f"<body><main class=pair><h1>{_e(t['compare_title'])}</h1>"
        f"{_column(bundle_a, 'a', t)}{_column(bundle_b, 'b', t)}"
        f"<footer>{_e(t['exported'])}</footer></main></body></html>"
    )

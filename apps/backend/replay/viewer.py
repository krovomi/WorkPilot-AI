"""A `.wpreplay` bundle as one HTML page anyone can open (#347).

The page needs nothing installed: no WorkPilot, no provider SDK, no network.
It is written here, from the bundle already masked by `bundle.build_bundle`,
and it carries no script at all: every text of the session is escaped, the
steps fold with ``<details>``, and a bookmark is a link to its step. Its
Content-Security-Policy allows only its own style sheet, by hash, so a text
that slipped through as markup would still run nothing. A summary a model
wrote of the steps is shown above them, said to be a model's.

The page speaks English or French, as the app that wrote it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from html import escape
from typing import Any

LABELS: dict[str, dict[str, str]] = {
    "en": {
        "title": "Agent replay",
        "agent": "Agent",
        "model": "Model",
        "task": "Task",
        "started": "Started (UTC)",
        "duration": "Duration",
        "steps": "Steps",
        "tokens": "Tokens",
        "cost": "Cost",
        "bookmarks": "Bookmarks",
        "step": "Step",
        "reasoning": "Reasoning",
        "tool": "Tool",
        "input": "Input",
        "output": "Output",
        "files": "Files",
        "options": "Options considered",
        "chosen": "Chosen",
        "redacted": "Secrets and local paths were masked before export.",
        "no_thinking": "No thinking trace is available for this model.",
        "thinking_removed": "The reasoning was removed before export.",
        "tokens_removed": "Token counts and costs were removed before export.",
        "no_steps": "This session has no steps.",
        "exported": "Exported by WorkPilot AI",
        "summary": "Summary of the steps",
        "summary_by": "Written by a model ({model}) from the recorded steps.",
    },
    "fr": {
        "title": "Rejeu d'agent",
        "agent": "Agent",
        "model": "Modèle",
        "task": "Tâche",
        "started": "Début (UTC)",
        "duration": "Durée",
        "steps": "Étapes",
        "tokens": "Tokens",
        "cost": "Coût",
        "bookmarks": "Signets",
        "step": "Étape",
        "reasoning": "Raisonnement",
        "tool": "Outil",
        "input": "Entrée",
        "output": "Sortie",
        "files": "Fichiers",
        "options": "Options envisagées",
        "chosen": "Choix",
        "redacted": "Les secrets et les chemins locaux ont été masqués avant l'export.",
        "no_thinking": "Aucune trace de raisonnement n'est disponible pour ce modèle.",
        "thinking_removed": "Le raisonnement a été retiré avant l'export.",
        "tokens_removed": "Les tokens et les coûts ont été retirés avant l'export.",
        "no_steps": "Cette session n'a aucune étape.",
        "exported": "Exporté par WorkPilot AI",
        "summary": "Résumé des étapes",
        "summary_by": "Écrit par un modèle ({model}) à partir des étapes enregistrées.",
    },
}

STYLE = (
    ":root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;"
    "--card:#f6f8fa;--line:#d1d9e0;--add:#1a7f37;--del:#cf222e;--mark:#9a6700}"
    "@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;"
    "--bg:#0d1117;--card:#151b23;--line:#3d444d;--add:#3fb950;--del:#f85149;"
    "--mark:#d29922}}"
    "body{margin:0;background:var(--bg);color:var(--fg);"
    "font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}"
    "main{max-width:960px;margin:0 auto;padding:24px 16px}"
    "h1{font-size:22px;margin:0 0 12px}h2{font-size:17px;margin:24px 0 8px}"
    "dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}"
    "dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}"
    ".note{color:var(--muted);font-size:13px;margin:4px 0}"
    "details{background:var(--card);border:1px solid var(--line);border-radius:8px;"
    "margin:6px 0;padding:8px 12px}summary{cursor:pointer;overflow-wrap:anywhere}"
    ".kind{font-family:ui-monospace,monospace;font-size:12px;color:var(--muted);"
    "margin-right:8px}.marked{border-color:var(--mark)}"
    "pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,"
    "SFMono-Regular,Menlo,monospace;margin:4px 0}"
    ".add{color:var(--add)}.del{color:var(--del)}"
    "ol.marks{padding-left:20px}a{color:inherit}"
    "footer{color:var(--muted);font-size:12px;margin-top:32px}"
)


def _csp() -> str:
    digest = base64.b64encode(hashlib.sha256(STYLE.encode("utf-8")).digest())
    return f"default-src 'none'; style-src 'sha256-{digest.decode('ascii')}'"


def _e(value: Any) -> str:
    return escape(str(value), quote=True)


def _duration(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _row(label: str, value: Any) -> str:
    return (
        f"<dt>{_e(label)}</dt><dd>{_e(value)}</dd>" if value not in ("", None) else ""
    )


def _diff_line(line: str) -> str:
    kind = "add" if line.startswith("+") else "del" if line.startswith("-") else ""
    css = f' class="{kind}"' if kind else ""
    return f"<span{css}>{_e(line)}</span>"


def _files(step: dict[str, Any], t: dict[str, str]) -> str:
    parts: list[str] = []
    for diff in step.get("file_diffs", []):
        lines = "\n".join(_diff_line(line) for line in diff.get("diff_lines") or [])
        parts.append(
            f"<p>{_e(diff.get('operation', ''))} <code>{_e(diff.get('file_path', ''))}"
            f"</code></p>" + (f"<pre>{lines}</pre>" if lines else "")
        )
    return f"<h3 class=note>{_e(t['files'])}</h3>{''.join(parts)}" if parts else ""


def _block(label: str, text: Any) -> str:
    if text in ("", None):
        return ""
    heading = f"<h3 class=note>{_e(label)}</h3>" if label else ""
    return f"{heading}<pre>{_e(text)}</pre>"


def _step(step: dict[str, Any], marked: set[int], t: dict[str, str]) -> str:
    index = step.get("step_index", 0)
    tool_input = step.get("tool_input")
    options = step.get("options_considered") or []
    body = "".join(
        [
            _block("", step.get("description")),
            _block(t["reasoning"], step.get("reasoning")),
            _block(t["tool"], step.get("tool_name")),
            _block(t["input"], json.dumps(tool_input, indent=2, ensure_ascii=False))
            if tool_input
            else "",
            _block(t["output"], step.get("tool_output")),
            _block(t["options"], "\n".join(options)) if options else "",
            _block(t["chosen"], step.get("chosen_option")),
            _files(step, t),
        ]
    )
    css = ' class="marked"' if index in marked else ""
    return (
        f'<details id="step-{_e(index)}"{css}><summary><span class=kind>'
        f"#{_e(index)} {_e(step.get('step_type', ''))}</span>"
        f"{_e(step.get('label', ''))}</summary>{body}</details>"
    )


def _bookmarks(bookmarks: list[dict[str, Any]], t: dict[str, str]) -> str:
    if not bookmarks:
        return ""
    items = "".join(
        f'<li><a href="#step-{_e(b.get("step_index", 0))}">{_e(t["step"])} '
        f"{_e(b.get('step_index', 0))}</a>"
        + (f" · {_e(b['author'])}" if b.get("author") else "")
        + f"<pre>{_e(b.get('note', ''))}</pre></li>"
        for b in bookmarks
    )
    return f"<h2>{_e(t['bookmarks'])}</h2><ol class=marks>{items}</ol>"


def _summary(summary: Any, t: dict[str, str]) -> str:
    if not isinstance(summary, dict) or not summary.get("text"):
        return ""
    model = " · ".join(
        str(part) for part in (summary.get("provider"), summary.get("model")) if part
    )
    by = t["summary_by"].format(model=model or "?")
    return (
        f'<h2 id="summary">{_e(t["summary"])}</h2><p class=note>{_e(by)}</p>'
        f"<pre>{_e(summary['text'])}</pre>"
    )


def _notes(bundle: dict[str, Any], t: dict[str, str]) -> str:
    notes = [t["redacted"]]
    if bundle.get("thinking") == "removed":
        notes.append(t["thinking_removed"])
    elif bundle.get("thinking") == "none":
        notes.append(t["no_thinking"])
    if bundle.get("options", {}).get("strip_tokens"):
        notes.append(t["tokens_removed"])
    return "".join(f"<p class=note>{_e(n)}</p>" for n in notes)


def render_viewer(bundle: dict[str, Any], language: str = "en") -> str:
    """The whole page for ``bundle``, which `build_bundle` produced."""
    t = LABELS.get(language, LABELS["en"])
    session: dict[str, Any] = bundle["session"]
    steps: list[dict[str, Any]] = session.get("steps", [])
    bookmarks: list[dict[str, Any]] = session.get("bookmarks", [])
    marked = {b.get("step_index", 0) for b in bookmarks}
    stripped = bundle.get("options", {}).get("strip_tokens")
    agent = " · ".join(
        part for part in (session.get("agent_name"), session.get("agent_role")) if part
    )
    label = session.get("model_label") or session.get("model")
    model = " · ".join(part for part in (session.get("provider"), label) if part)
    started = time.strftime("%Y-%m-%d %H:%M", time.gmtime(session.get("start_time", 0)))
    facts = "".join(
        [
            _row(t["agent"], agent),
            _row(t["model"], model),
            _row(t["task"], session.get("task_description")),
            _row(t["started"], started),
            _row(t["duration"], _duration(session.get("duration_seconds", 0))),
            _row(t["steps"], len(steps)),
            "" if stripped else _row(t["tokens"], session.get("total_tokens", 0)),
            ""
            if stripped
            else _row(t["cost"], f"${session.get('total_cost_usd', 0):.4f}"),
        ]
    )
    timeline = "".join(_step(step, marked, t) for step in steps) or (
        f"<p class=note>{_e(t['no_steps'])}</p>"
    )
    lang = language if language in LABELS else "en"
    return (
        f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
        f'<meta http-equiv="Content-Security-Policy" content="{_e(_csp())}">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="referrer" content="no-referrer">'
        f"<title>{_e(t['title'])}</title><style>{STYLE}</style></head><body><main>"
        f"<h1>{_e(t['title'])}</h1><dl>{facts}</dl>{_notes(bundle, t)}"
        f"{_summary(session.get('summary'), t)}{_bookmarks(bookmarks, t)}<h2>{_e(t['steps'])}</h2>{timeline}"
        f"<footer>{_e(t['exported'])}</footer></main></body></html>"
    )

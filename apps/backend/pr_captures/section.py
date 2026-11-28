"""The "Captures" section of a pull request body, between two markers.

Pure: the caller hosts the images (`core.capture_hosting`) and hands this
module one URL per published copy; this module writes the Markdown and puts it
in the body, replacing an earlier section, so that a later sync updates the
section instead of adding a second one.

A label comes from the verification (a model wrote it): it reaches the body as
plain text, stripped of anything Markdown or HTML would read as markup.
"""

from __future__ import annotations

import re
from collections.abc import Collection, Mapping

__all__ = [
    "END",
    "START",
    "hosted_files",
    "render_section",
    "replace_section",
]

START = "<!-- workpilot-captures:start -->"
END = "<!-- workpilot-captures:end -->"
_BLOCK = re.compile(re.escape(START) + r".*?" + re.escape(END) + r"\n?", re.DOTALL)
_MARKUP = re.compile(r"[\\`*_{}\[\]()<>#|!~\r\n\t]+")
MAX_LABEL = 60

_TEXT = {
    "fr": {
        "title": "Captures",
        "screen": "Écran",
        "before": "Avant",
        "after": "Après",
        "phone": "téléphone",
        "none": "—",
        "fakes": "Les données personnelles de ces captures sont remplacées par de "
        "fausses valeurs du même format.",
        "unprotected": "Ces captures sont publiées sans remplacement des données "
        "personnelles (réglage de l'équipe).",
        "withheld": "{n} capture(s) restent sur la tâche : aucune vérification n'a "
        "pu les lire ou une valeur n'a pas pu être remplacée.",
        "more": "{n} autre(s) écran(s) sur la tâche.",
    },
    "en": {
        "title": "Screenshots",
        "screen": "Screen",
        "before": "Before",
        "after": "After",
        "phone": "phone",
        "none": "—",
        "fakes": "Personal data in these screenshots is replaced by fake values of "
        "the same format.",
        "unprotected": "These screenshots are published without replacing personal "
        "data (team setting).",
        "withheld": "{n} screenshot(s) stay on the task: no check could read them or "
        "a value could not be replaced.",
        "more": "{n} more screen(s) on the task.",
    },
}


def _plain(value: object) -> str:
    text = _MARKUP.sub(" ", str(value or ""))
    text = " ".join(text.split())
    return text[:MAX_LABEL].strip()


def _side_file(item: Mapping, side: str) -> str:
    entry = item.get(side)
    if not isinstance(entry, Mapping) or not entry.get("publishable"):
        return ""
    file = entry.get("file")
    return file if isinstance(file, str) else ""


def _signature(item: Mapping, side: str) -> str:
    entry = item.get(side)
    return str(entry.get("signature") or "") if isinstance(entry, Mapping) else ""


def hosted_files(
    publication: Mapping | None, approved: Collection[str] | None = None
) -> list[str]:
    """The published copies a pull request may show: each screen's after, then its before.

    A screen whose "after" is held back shows nothing, its "before" neither.
    `approved` (signatures a person published, `CAPTURES_PUBLISH=review`)
    keeps only the copies of images that person saw; None keeps every copy.
    """
    if not publication or not (publication.get("decision") or {}).get("needed"):
        return []
    files: list[str] = []
    for item in publication.get("items") or []:
        if not isinstance(item, Mapping) or not item.get("publishable"):
            continue
        for side in ("after", "before"):
            file = _side_file(item, side)
            if approved is not None and _signature(item, side) not in approved:
                if side == "after":
                    break
                continue
            if file and file not in files:
                files.append(file)
    return files


def _screen(item: Mapping, text: Mapping[str, str]) -> str:
    platform = str(item.get("platform") or "")
    route = _plain(item.get("route"))
    if platform == "web" or (route and platform == "desktop"):
        name = f"/{route}" if route else "/"
    else:
        name = _plain(item.get("label")) or platform or text["screen"]
    if item.get("variant") == "mobile":
        name = f"{name} · {text['phone']}"
    return name


def _cell(file: str, urls: Mapping[str, str], alt: str, text: Mapping[str, str]) -> str:
    url = urls.get(file) if file else None
    if not url:
        return text["none"]
    return f"![{alt}]({url.replace(' ', '%20').replace(')', '%29')})"


def render_section(
    publication: Mapping | None,
    urls: Mapping[str, str],
    *,
    lang: str = "fr",
    max_chars: int | None = None,
) -> str:
    """The section for these hosted copies, or "" when the PR shows none.

    `max_chars` bounds the whole section (Azure DevOps keeps 4,000 characters
    of a description): screens are dropped from the end, and a line says how
    many stayed on the task.
    """
    text = _TEXT.get(lang, _TEXT["en"])
    if not publication or not (publication.get("decision") or {}).get("needed"):
        return ""
    rows: list[str] = []
    for item in publication.get("items") or []:
        if not isinstance(item, Mapping) or not item.get("publishable"):
            continue
        after = _side_file(item, "after")
        if not urls.get(after):
            continue
        name = _screen(item, text)
        before_cell = _cell(
            _side_file(item, "before"), urls, f"{text['before']} {name}", text
        )
        after_cell = _cell(after, urls, f"{text['after']} {name}", text)
        rows.append(f"| {name} | {before_cell} | {after_cell} |")
    withheld = int(publication.get("withheld") or 0)
    protected = (publication.get("settings") or {}).get("protect", True) is not False
    if not rows and not withheld:
        return ""

    def build(kept: list[str]) -> str:
        lines = [START, f"### 📸 {text['title']}", ""]
        if kept:
            lines += [
                f"| {text['screen']} | {text['before']} | {text['after']} |",
                "|---|---|---|",
                *kept,
                "",
                f"_{text['fakes'] if protected else text['unprotected']}_",
            ]
        if len(kept) < len(rows):
            lines.append(f"_{text['more'].format(n=len(rows) - len(kept))}_")
        if withheld:
            lines.append(f"_{text['withheld'].format(n=withheld)}_")
        lines.append(END)
        return "\n".join(lines) + "\n"

    kept = list(rows)
    section = build(kept)
    while max_chars is not None and len(section) > max_chars and kept:
        kept.pop()
        section = build(kept)
    if max_chars is not None and len(section) > max_chars:
        return ""
    return section


def replace_section(body: str | None, section: str) -> str:
    """`body` with its captures section replaced by `section` ("" removes it)."""
    body = body or ""
    if _BLOCK.search(body):
        updated = _BLOCK.sub(lambda _m: section, body, count=1)
        return re.sub(r"\n{3,}", "\n\n", updated)
    if not section:
        return body
    return f"{body.rstrip()}\n\n{section}" if body.strip() else section

"""The WCAG 2.2 checks read from source, the same for every stack (#391).

Each rule reads the elements of ``markup.parse`` (or the CSS of the file) and
reports what it is sure of. When the source cannot tell (an attribute set by
an expression, props spread on the element, a component whose output is
unknown), the rule stays silent: a false alarm costs the person more than a
missed one, which the dynamic scan can still catch.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

from .contrast import (
    Tokens,
    pairs_in_classes,
    pairs_in_css,
    pairs_in_style,
    required_ratio,
)
from .markup import Element, Markup

__all__ = ["RULES", "Hit", "Rule", "check", "LEVEL_ORDER"]

LEVEL_ORDER = {"A": 1, "AA": 2, "AAA": 3}


@dataclass(frozen=True)
class Rule:
    rule_id: str
    criterion: str
    level: str
    severity: str
    description: str
    suggestion: str


@dataclass(frozen=True)
class Hit:
    rule: Rule
    element: Element | None
    line: int
    detail: str = ""
    snippet: str = ""


def _rule(*args: str) -> Rule:
    return Rule(*args)


RULES: dict[str, Rule] = {
    r.rule_id: r
    for r in (
        _rule("img-alt", "1.1.1", "A", "critical", "Image without a text alternative",
              'Add alt="what the image shows", or alt="" when it is decorative'),
        _rule("img-alt-meaningful", "1.1.1", "A", "moderate", "Image alternative is a file name or a placeholder",
              "Describe what the image shows, not its file"),
        _rule("svg-img-name", "1.1.1", "A", "serious", 'SVG with role="img" has no name',
              "Add a <title> as first child, or aria-label"),
        _rule("control-label", "1.3.1", "A", "serious", "Form control without a label",
              'Link a <label for="id">, wrap it in <label>, or add aria-label; a placeholder is not a label'),
        _rule("button-name", "4.1.2", "A", "critical", "Button without an accessible name",
              "Give it text, or aria-label for an icon-only button"),
        _rule("link-name", "2.4.4", "A", "serious", "Link without an accessible name",
              "Give it text that says where it goes, or aria-label"),
        _rule("heading-order", "1.3.1", "A", "moderate", "Heading level skipped",
              "Go down one level at a time (h2 after h1, h3 after h2)"),
        _rule("page-lang", "3.1.1", "A", "serious", "Page language not declared",
              'Add lang to <html>, for example <html lang="en">'),
        _rule("page-title", "2.4.2", "A", "serious", "Page without a <title>",
              "Add a <title> that says what the page is"),
        _rule("tabindex-positive", "2.4.3", "A", "moderate", "Positive tabindex reorders keyboard navigation",
              'Use tabindex="0" (or -1) and order the markup instead'),
        _rule("click-without-keyboard", "2.1.1", "A", "serious", "Clickable element the keyboard cannot reach or use",
              'Use a <button>, or add role, tabindex="0" and a key handler'),
        _rule("anchor-is-valid", "2.1.1", "A", "moderate", 'Link with href="#" or javascript: used as a button',
              "Use a <button> for an action, a real href for a link"),
        _rule("aria-role", "4.1.2", "A", "serious", "ARIA role that does not exist",
              "Use a WAI-ARIA 1.2 role, or remove it"),
        _rule("aria-hidden-focus", "4.1.2", "A", "serious", 'Focusable element inside aria-hidden="true"',
              'Remove it from the tab order (tabindex="-1", inert) or do not hide it'),
        _rule("video-captions", "1.2.2", "A", "critical", "Video without captions",
              'Add <track kind="captions" src="…" srclang="…">'),
        _rule("iframe-title", "4.1.2", "A", "serious", "Frame without a title",
              "Add title that says what the frame holds"),
        _rule("skip-link", "2.4.1", "A", "moderate", "No way to skip the navigation",
              'Add a first link <a href="#main">Skip to content</a> and id="main" on <main>'),
        _rule("meta-viewport", "1.4.4", "AA", "serious", "Zoom disabled by the viewport",
              "Remove user-scalable=no and maximum-scale below 2"),
        _rule("focus-visible", "2.4.7", "AA", "serious", "Focus outline removed with nothing in its place",
              "Keep an outline, or give :focus-visible a ring, border or shadow"),
        _rule("color-contrast", "1.4.3", "AA", "serious", "Text contrast below 4.5:1 (3:1 for large text)",
              "Darken the text or lighten the background until the ratio passes"),
        _rule("target-size", "2.5.8", "AA", "moderate", "Pointer target smaller than 24×24 px",
              "Make it at least 24×24 px, padding included, or space it from its neighbours"),
        _rule("color-contrast-enhanced", "1.4.6", "AAA", "minor", "Text contrast below 7:1 (4.5:1 for large text)",
              "Darken the text or lighten the background until the ratio passes"),
        _rule("target-size-enhanced", "2.5.5", "AAA", "minor", "Pointer target smaller than 44×44 px",
              "Make it at least 44×44 px"),
    )
}  # fmt: skip

_ROLES = frozenset(
    """alert alertdialog application article banner blockquote button caption cell checkbox
    code columnheader combobox complementary contentinfo definition deletion dialog directory
    document emphasis feed figure form generic grid gridcell group heading img insertion link
    list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox
    menuitemradio meter navigation none note option paragraph presentation progressbar radio
    radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider
    spinbutton status strong subscript superscript switch tab table tablist tabpanel term
    textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments
    doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref
    doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication
    doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote
    doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice
    doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna
    doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol""".split()
)
_INTERACTIVE = frozenset(
    {"a", "button", "input", "select", "textarea", "summary", "option", "details"}
)
_INTERACTIVE_ROLES = frozenset(
    {"button", "link", "checkbox", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
     "radio", "switch", "tab", "treeitem", "slider", "spinbutton", "textbox", "combobox", "gridcell"}
)  # fmt: skip
_NAMING = ("aria-label", "aria-labelledby", "title")
_KEY_HANDLERS = ("onkeydown", "onkeyup", "onkeypress")
_ICON_MODULES = re.compile(
    r"^(lucide|@heroicons|react-icons|@mui/icons-material|@fortawesome|@tabler/icons|"
    r"@radix-ui/react-icons|@phosphor-icons|bootstrap-icons|@iconify|@ant-design/icons|"
    r"@primer/octicons|feather-icons|ionicons|@expo/vector-icons|@fluentui/react-icons)"
)
_PLACEHOLDER_ALT = re.compile(
    r"^\s*(image|img|photo|picture|icon|logo|graphic|placeholder|untitled|\w[\w-]*\.(png|jpe?g|gif|svg|webp|avif))\s*$",
    re.I,
)
_HAS_EXPRESSION = re.compile(r"\{[^}]*\}|@[\w(]|<\?|<%=|\$\{")
_UNLABELLED_INPUTS = frozenset({"hidden", "submit", "button", "reset", "image"})


def _bound_or_set(element: Element, *names: str) -> bool:
    """True when one of ``names`` is present: bound, or static and not empty."""
    for name in names:
        attr = element.attrs.get(name)
        if attr is None:
            continue
        if attr.bound or (attr.value or "").strip():
            return True
    return False


def _icon(markup: Markup, element: Element) -> bool:
    module = markup.imports.get(element.name.split(".")[0], "")
    return bool(_ICON_MODULES.match(module)) or element.name.endswith("Icon")


def _has_name_from_content(markup: Markup, element: Element) -> bool:
    """True when the content may give a name: text, an expression, a named image, a component."""
    text = re.sub(r"<[^>]*>", " ", element.inner)
    if text.strip() and (re.search(r"[^\s&;]", text) or _HAS_EXPRESSION.search(text)):
        return True
    for child in element.descendants():
        if child.name in ("img", "area") and _bound_or_set(child, "alt", *_NAMING):
            return True
        if child.name == "svg" and (
            _bound_or_set(child, *_NAMING)
            or any(g.name == "title" for g in child.children)
        ):
            return True
        if _bound_or_set(child, "aria-label", "aria-labelledby"):
            return True
        if child.is_component and not _icon(markup, child):
            return True  # may render text: unknown, not reported
        if child.spread:
            return True
    return False


def _focusable(element: Element) -> bool:
    tabindex = element.static("tabindex")
    if tabindex is not None and tabindex.strip().lstrip("-").isdigit():
        return int(tabindex) >= 0
    if element.name == "a":
        return element.has("href")
    if element.name in ("button", "select", "textarea", "summary"):
        return not element.has("disabled")
    if element.name == "input":
        return element.static("type") != "hidden" and not element.has("disabled")
    return element.has("contenteditable")


def _role(element: Element) -> str:
    return (element.static("role") or "").strip().lower()


def _img_rules(markup: Markup) -> Iterator[Hit]:
    for el in markup.elements:
        name = el.name
        if name in ("img", "area") or (
            name == "input" and el.static("type") == "image"
        ):
            if el.spread or el.static("aria-hidden") == "true":
                continue
            if _role(el) in ("presentation", "none"):
                continue
            if not el.has("alt") and not _bound_or_set(
                el, "aria-label", "aria-labelledby"
            ):
                yield Hit(RULES["img-alt"], el, el.line)
            elif (alt := el.static("alt")) and _PLACEHOLDER_ALT.match(alt):
                yield Hit(RULES["img-alt-meaningful"], el, el.line, detail=alt)
        elif name == "svg" and _role(el) == "img" and not el.spread:
            if not _bound_or_set(el, *_NAMING) and not any(
                c.name == "title" for c in el.children
            ):
                yield Hit(RULES["svg-img-name"], el, el.line)
        elif el.is_component and re.search(r"(^|\.)(Image|Img|Avatar)$", el.name):
            # next/image, astro:assets, expo-image, Nuxt <NuxtImg>… all take `alt`.
            if (
                el.has("src")
                and not el.spread
                and not el.has("alt", "aria-label", "aria-hidden")
            ):
                yield Hit(RULES["img-alt"], el, el.line)


def _labelled_ids(markup: Markup) -> tuple[set[str], bool]:
    labels = markup.find("label")
    ids = {lab.static("for") for lab in labels if lab.static("for")}
    for el in markup.elements:
        labelledby = el.static("aria-labelledby")
        if labelledby:
            ids.update(labelledby.split())
    dynamic = any(lab.attrs.get("for") and lab.attrs["for"].bound for lab in labels)
    return ids, dynamic


def _control_rules(markup: Markup) -> Iterator[Hit]:
    ids, dynamic_for = _labelled_ids(markup)
    for el in markup.find("input", "select", "textarea"):
        if el.spread:
            continue
        if (
            el.name == "input"
            and (el.static("type") or "text").lower() in _UNLABELLED_INPUTS
        ):
            continue
        if el.has("aria-hidden") or _bound_or_set(el, *_NAMING):
            continue
        if any(a.name == "label" for a in el.ancestors()):
            continue
        id_attr = el.attrs.get("id")
        if id_attr and (id_attr.bound or dynamic_for or id_attr.value in ids):
            continue
        detail = "placeholder only" if el.has("placeholder") else ""
        yield Hit(RULES["control-label"], el, el.line, detail=detail)


def _name_rules(markup: Markup) -> Iterator[Hit]:
    for el in markup.elements:
        if el.spread or el.name == "input":
            continue
        role = _role(el)
        if el.name == "button" or role == "button":
            kind = "button-name"
        elif (el.name == "a" and el.has("href")) or role == "link":
            kind = "link-name"
        else:
            continue
        if el.has("aria-hidden") or _bound_or_set(el, *_NAMING):
            continue
        if not _has_name_from_content(markup, el):
            yield Hit(RULES[kind], el, el.line)


def _heading_rules(markup: Markup) -> Iterator[Hit]:
    previous: int | None = None
    for el in markup.elements:
        level: int | None = None
        if re.fullmatch(r"h[1-6]", el.name):
            level = int(el.name[1])
        elif _role(el) == "heading" and (el.static("aria-level") or "").isdigit():
            level = int(el.static("aria-level") or 0)
        if level is None:
            continue
        if previous is not None and level > previous + 1 and not el.conditional:
            yield Hit(
                RULES["heading-order"], el, el.line, detail=f"h{previous} → h{level}"
            )
        previous = level


def _document_rules(markup: Markup) -> Iterator[Hit]:
    for html in markup.find("html"):
        if not _bound_or_set(html, "lang", "xml:lang") and not html.spread:
            yield Hit(RULES["page-lang"], html, html.line)
    for head in markup.find("head"):
        if not any(
            c.name == "title" or c.is_component and c.name.endswith("Title")
            for c in head.descendants()
        ):
            yield Hit(RULES["page-title"], head, head.line)
    for meta in markup.find("meta"):
        if (meta.static("name") or "").lower() != "viewport":
            continue
        content = (meta.static("content") or "").lower().replace(" ", "")
        scale = re.search(r"maximum-scale=([\d.]+)", content)
        if (
            "user-scalable=no" in content
            or "user-scalable=0" in content
            or (scale and float(scale.group(1)) < 2)
        ):
            yield Hit(RULES["meta-viewport"], meta, meta.line, detail=content[:80])
    navs, mains = markup.find("nav"), markup.find("main")
    if navs and mains:
        ids = markup.ids()
        skip = any(
            (a.static("href") or "").startswith("#")
            and (a.static("href") or "")[1:] in ids
            for a in markup.find("a")
            if a.start < navs[0].start
        )
        if not skip:
            yield Hit(RULES["skip-link"], navs[0], navs[0].line)


def _keyboard_rules(markup: Markup) -> Iterator[Hit]:
    for el in markup.elements:
        tabindex = el.static("tabindex")
        if tabindex and tabindex.strip().isdigit() and int(tabindex) > 0:
            yield Hit(
                RULES["tabindex-positive"], el, el.line, detail=f"tabindex={tabindex}"
            )
        role = _role(el)
        if el.name not in _INTERACTIVE and not el.is_component and el.has("onclick"):
            missing = []
            if not el.has(*_KEY_HANDLERS):
                missing.append("key handler")
            if role not in _INTERACTIVE_ROLES:
                missing.append("role")
            if not el.has("tabindex"):
                missing.append("tabindex")
            if missing:
                yield Hit(
                    RULES["click-without-keyboard"],
                    el,
                    el.line,
                    detail=", ".join(missing),
                )
        if el.name == "a":
            href = (el.static("href") or "").strip()
            fake = href in ("#", "") and el.has("href") and el.has("onclick")
            if fake or href.lower().startswith("javascript:"):
                yield Hit(RULES["anchor-is-valid"], el, el.line, detail=href[:40])
        if role and not el.attrs["role"].bound:
            if not any(token in _ROLES for token in role.split()):
                yield Hit(RULES["aria-role"], el, el.line, detail=role[:40])
        if el.static("aria-hidden") == "true":
            for node in (el, *el.descendants()):
                if _focusable(node) and node.static("tabindex") != "-1":
                    yield Hit(RULES["aria-hidden-focus"], node, node.line)
                    break


def _media_rules(markup: Markup) -> Iterator[Hit]:
    for video in markup.find("video"):
        if video.spread or video.has("muted") or video.has("aria-hidden"):
            continue
        tracks = [t for t in video.descendants() if t.name == "track"]
        if not any(
            (t.static("kind") or "subtitles").lower() in ("captions", "subtitles")
            for t in tracks
        ):
            yield Hit(RULES["video-captions"], video, video.line)
    for frame in markup.find("iframe", "frame"):
        if (
            frame.spread
            or frame.has("aria-hidden")
            or _bound_or_set(frame, "title", "aria-label", "aria-labelledby")
        ):
            continue
        yield Hit(RULES["iframe-title"], frame, frame.line)


# --- CSS: focus, contrast, target size ---------------------------------------

_STYLE_BLOCK = re.compile(r"<style\b[^>]*>(.*?)</style>", re.S | re.I)
_CSS_SUFFIXES = (".css", ".scss", ".sass", ".less", ".styl", ".pcss")
_OUTLINE_NONE = re.compile(r"outline\s*:\s*(none|0)\b|outline-style\s*:\s*none", re.I)
_REPLACEMENT = re.compile(
    r"(box-shadow|border(-color)?|outline(-color|-offset|-width)?)\s*:\s*(?!none|0\b)",
    re.I,
)
_TW_SIZE = re.compile(r"^(w|h|size|min-w|min-h)-(\d+(?:\.5)?|\[(\d+)px\])$")


def css_sources(markup: Markup) -> list[tuple[str, int]]:
    """The CSS of the file with the line it starts at: the whole file, or its <style> blocks."""
    if markup.path.lower().endswith(_CSS_SUFFIXES):
        return [(markup.text, 1)]
    return [
        (m.group(1), markup.line_of(m.start(1)))
        for m in _STYLE_BLOCK.finditer(markup.text)
    ]


def _focus_rules(markup: Markup) -> Iterator[Hit]:
    for css, first in css_sources(markup):
        visible = ":focus-visible" in css
        for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
            selector, body = match.group(1), match.group(2)
            if ":focus" not in selector or ":focus-visible" in selector:
                continue
            if _OUTLINE_NONE.search(body) and not _REPLACEMENT.search(
                _OUTLINE_NONE.sub("", body)
            ):
                if not visible:
                    line = first + css.count("\n", 0, match.start(2))
                    yield Hit(
                        RULES["focus-visible"],
                        None,
                        line,
                        snippet=" ".join(selector.split())[:120],
                    )
    for el in markup.elements:
        classes = (el.static("class") or "").split()
        if not classes:
            continue
        removed = any(
            c in ("outline-none", "focus:outline-none", "focus:outline-0")
            for c in classes
        )
        replaced = any(
            re.match(
                r"(focus|focus-visible|focus-within):(ring|outline|border|shadow)(?!-none|-0)",
                c,
            )
            for c in classes
        )
        if removed and not replaced and (_focusable(el) or el.name in _INTERACTIVE):
            yield Hit(RULES["focus-visible"], el, el.line, detail="outline-none")


def _contrast_hits(pair, level: str, element: Element | None) -> Iterator[Hit]:
    detail = f"{pair.foreground} on {pair.background}: {pair.ratio}:1"
    if pair.ratio < required_ratio("AA", pair.large):
        yield Hit(
            RULES["color-contrast"],
            element,
            pair.line,
            detail=detail,
            snippet=pair.where,
        )
    elif level == "AAA" and pair.ratio < required_ratio("AAA", pair.large):
        yield Hit(
            RULES["color-contrast-enhanced"],
            element,
            pair.line,
            detail=detail,
            snippet=pair.where,
        )


def _contrast_rules(markup: Markup, tokens: Tokens, level: str) -> Iterator[Hit]:
    for css, first in css_sources(markup):
        for pair in pairs_in_css(css, tokens, first):
            yield from _contrast_hits(pair, level, None)
    for el in markup.elements:
        style = el.static("style")
        if style:
            pair = pairs_in_style(style, tokens, el.line)
            if pair:
                yield from _contrast_hits(pair, level, el)
        classes = el.static("class")
        if classes:
            pair = pairs_in_classes(classes, tokens, el.line)
            if pair:
                yield from _contrast_hits(pair, level, el)


def _px(value: str) -> float | None:
    match = re.fullmatch(r"\s*([\d.]+)px\s*", value)
    return float(match.group(1)) if match else None


def _target_size(el: Element) -> tuple[float, float] | None:
    style = el.static("style") or ""
    decls = {
        k.strip().lower(): v.strip()
        for k, _, v in (p.partition(":") for p in style.split(";") if ":" in p)
    }
    width, height = _px(decls.get("width", "")), _px(decls.get("height", ""))
    classes = (el.static("class") or "").split()
    if (
        any(re.match(r"(p|px|py|pt|pb|pl|pr)-", c) for c in classes)
        or "padding" in decls
    ):
        return None  # padding grows the target: unknown size
    for c in classes:
        match = _TW_SIZE.match(c)
        if not match:
            continue
        px = float(match.group(3)) if match.group(3) else float(match.group(2)) * 4
        kind = match.group(1)
        if kind in ("w", "min-w", "size"):
            width = max(width or 0, px)
        if kind in ("h", "min-h", "size"):
            height = max(height or 0, px)
    if width is None or height is None:
        return None
    return width, height


def _target_rules(markup: Markup, level: str) -> Iterator[Hit]:
    for el in markup.elements:
        if not (el.name in ("button", "a") or _role(el) in ("button", "link")):
            continue
        if (
            el.name == "a"
            and el.parent is not None
            and el.parent.name in ("p", "li", "span")
        ):
            continue  # inline links are exempt (2.5.8)
        size = _target_size(el)
        if size is None:
            continue
        width, height = size
        detail = f"{width:g}×{height:g} px"
        if min(width, height) < 24:
            yield Hit(RULES["target-size"], el, el.line, detail=detail)
        elif level == "AAA" and min(width, height) < 44:
            yield Hit(RULES["target-size-enhanced"], el, el.line, detail=detail)


def check(markup: Markup, tokens: Tokens | None = None, level: str = "AA") -> list[Hit]:
    """Every rule at or below ``level`` on one file."""
    tokens = tokens or Tokens()
    hits: list[Hit] = []
    for producer in (
        _img_rules(markup),
        _control_rules(markup),
        _name_rules(markup),
        _heading_rules(markup),
        _document_rules(markup),
        _keyboard_rules(markup),
        _media_rules(markup),
        _focus_rules(markup),
        _contrast_rules(markup, tokens, level),
        _target_rules(markup, level),
    ):
        hits.extend(producer)
    wanted = LEVEL_ORDER.get(level, 2)
    return [h for h in hits if LEVEL_ORDER[h.rule.level] <= wanted]

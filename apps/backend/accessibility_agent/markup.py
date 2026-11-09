"""Markup read the same way in every stack the accessibility rules check (#391).

One tolerant reader for HTML and the template syntaxes built on it: JSX/TSX,
Vue, Svelte, Astro, Angular templates, Blazor/Razor, PHP/Blade, Twig, ERB and
Handlebars. It is not a validating parser: it finds the elements, their
attributes (static or bound) and their content, keeps line numbers, and never
raises on broken markup, so a half-written component is still checked.

Bindings are folded into the attribute they set, so the rules do not care
about the framework: ``:alt`` and ``v-bind:alt`` (Vue), ``[alt]`` and
``[attr.alt]`` (Angular), ``alt={...}`` (JSX, Svelte), ``alt="@x"`` (Razor)
are all ``alt``, marked bound. An element that spreads unknown props
(``{...props}``, ``v-bind="attrs"``) may set any attribute: the rules that
look for a missing one leave it alone rather than guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

__all__ = [
    "Attr",
    "Element",
    "Markup",
    "parse",
    "VOID_ELEMENTS",
]

VOID_ELEMENTS = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr",
    }
)  # fmt: skip

# Elements whose content is not markup.
_RAW_TEXT = frozenset({"script", "style", "textarea", "pre", "code"})

_NAME = re.compile(r"[A-Za-z][\w.:-]*")
_COMMENTS = (
    re.compile(r"<!--.*?-->", re.S),
    re.compile(r"\{/\*.*?\*/\}", re.S),  # JSX
    re.compile(r"@\*.*?\*@", re.S),  # Razor
    re.compile(r"\{\{--.*?--\}\}", re.S),  # Blade
    re.compile(r"\{#.*?#\}", re.S),  # Twig
    re.compile(r"<%#.*?%>", re.S),  # ERB
)
# A `<` that opens a tag follows one of these (ignoring spaces), never an
# identifier, `)` or `]`: that keeps `a < b` and `useState<string>()` out.
_TAG_CONTEXT = set("(=>{},?:;&|[!+-*/%\n\"'`")
_JS_LIKE = (".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs")

_CONDITIONAL_ATTRS = frozenset(
    {"v-if", "v-else-if", "v-else", "v-show", "*ngif", "x-if", "x-show", "hidden"}
)
_CONDITIONAL_BLOCK = re.compile(
    r"(?:\{#if\b|@if\s*\(|@if\b|\{%\s*if\b|<%\s*if\b|\{\{#if\b|&&\s*\(?\s*$|\?\s*\(?\s*$)"
)
_SPREAD_ATTR = re.compile(r"^\{\s*\.\.\.")


def _blank(match: re.Match[str]) -> str:
    """The match turned to spaces, newlines kept, so line numbers do not move."""
    return re.sub(r"[^\n]", " ", match.group(0))


@dataclass(frozen=True)
class Attr:
    """One attribute: its value when static, ``bound`` when an expression sets it."""

    value: str | None
    bound: bool = False

    @property
    def static(self) -> str | None:
        return None if self.bound else self.value


@dataclass
class Element:
    name: str
    """Lower-cased for HTML elements; components keep their case (``Image``)."""
    attrs: dict[str, Attr]
    line: int
    start: int
    open_end: int
    self_closing: bool = False
    spread: bool = False
    parent: Element | None = None
    children: list[Element] = field(default_factory=list)
    inner: str = ""
    """The source between the open and the close tag, comments blanked."""
    conditional: bool = False
    source: str = ""
    """The open tag as written, cut to 160 characters."""

    @property
    def is_component(self) -> bool:
        return self.name[:1].isupper() or "." in self.name

    def has(self, *names: str) -> bool:
        return any(n in self.attrs for n in names)

    def get(self, name: str) -> str | None:
        attr = self.attrs.get(name)
        return attr.value if attr else None

    def static(self, name: str) -> str | None:
        attr = self.attrs.get(name)
        return attr.static if attr else None

    def ancestors(self):
        node = self.parent
        while node is not None:
            yield node
            node = node.parent

    def descendants(self):
        for child in self.children:
            yield child
            yield from child.descendants()


@dataclass
class Markup:
    path: str
    text: str
    """The source with comments blanked."""
    elements: list[Element]
    imports: dict[str, str]
    """Component name → module it is imported from (JSX, Vue, Svelte, Astro)."""

    def line_of(self, offset: int) -> int:
        return self.text.count("\n", 0, offset) + 1

    def find(self, *names: str) -> list[Element]:
        wanted = set(names)
        return [e for e in self.elements if e.name.lower() in wanted]

    def ids(self) -> set[str]:
        return {e.static("id") for e in self.elements if e.static("id")}

    def is_external(self, element: Element) -> bool:
        """A component imported from a package, not from the project."""
        module = self.imports.get(element.name.split(".")[0])
        return bool(module) and not module.startswith((".", "/", "@/", "~/", "$lib"))


_IMPORT = re.compile(
    r"import\s+(?:type\s+)?(?P<what>[\w$]+(?:\s*,\s*\{[^}]*\})?|\{[^}]*\})\s+from\s+[\"'](?P<module>[^\"']+)[\"']"
)


def _imports(text: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for match in _IMPORT.finditer(text):
        module = match.group("module")
        for name in re.findall(r"[\w$]+(?:\s+as\s+[\w$]+)?", match.group("what")):
            local = name.split(" as ")[-1].strip()
            if local and local != "type":
                found[local] = module
    return found


def _normalise(name: str) -> tuple[str, bool]:
    """The attribute's plain name and whether the framework binds it."""
    raw = name
    bound = False
    if raw.startswith("v-bind:"):
        raw, bound = raw[7:], True
    elif raw.startswith(":") and not raw.startswith("::"):
        raw, bound = raw[1:], True
    elif raw.startswith("[") and raw.endswith("]"):
        raw, bound = raw[1:-1], True
        if raw.startswith("attr."):
            raw = raw[5:]
    elif raw.startswith("bind:"):
        raw, bound = raw[5:], True
    elif raw.startswith("@on") and len(raw) > 3:
        raw = raw[1:]  # Blazor: @onclick, @onkeydown
    elif raw.startswith(("v-on:", "@")):
        raw = "on" + raw.split(":", 1)[-1].lstrip("@")
    elif raw.startswith("(") and raw.endswith(")"):
        raw = "on" + raw[1:-1]
    elif raw.startswith("on:"):
        raw = "on" + raw[3:]
    lowered = raw.lower()
    # Modifiers: `@keydown.enter`, `(keydown.enter)`.
    if lowered.startswith("on") and "." in lowered:
        lowered = lowered.split(".", 1)[0]
    return {"classname": "class", "htmlfor": "for"}.get(lowered, lowered), bound


def _read_value(text: str, i: int) -> tuple[str, bool, int]:
    """The value starting at ``i``, whether it is an expression, and the index after it."""
    n = len(text)
    if i >= n:
        return "", False, i
    quote = text[i]
    if quote in "\"'`":
        end = text.find(quote, i + 1)
        end = n if end < 0 else end
        value = text[i + 1 : end]
        bound = bool(
            re.fullmatch(
                r"\s*(?:@[\w(].*|\{\{.*\}\}|<\?.*\?>|<%=.*%>|\$\{.*\})\s*", value, re.S
            )
        )
        return value, bound, end + 1
    if quote == "{":
        depth, j = 0, i
        while j < n:
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
            elif ch in "\"'`":
                close = text.find(ch, j + 1)
                j = n if close < 0 else close
            j += 1
        return text[i + 1 : j].strip(), True, j + 1
    match = re.match(r"[^\s>]+", text[i:])
    value = match.group(0) if match else ""
    if value.endswith("/") and text[i + len(value) : i + len(value) + 1] == ">":
        value = value[:-1]
    return value, value.startswith("@"), i + len(value)


def _read_tag(text: str, i: int) -> tuple[str, dict[str, Attr], bool, bool, int] | None:
    """Parse the open tag at ``text[i] == '<'``: name, attrs, spread, self-closing, end."""
    match = _NAME.match(text, i + 1)
    if not match:
        return None
    name = match.group(0)
    attrs: dict[str, Attr] = {}
    spread = False
    j, n = match.end(), len(text)
    while j < n:
        while j < n and text[j].isspace():
            j += 1
        if j >= n:
            return None
        if text.startswith("/>", j):
            return name, attrs, spread, True, j + 2
        if text[j] == ">":
            return name, attrs, spread, False, j + 1
        if text[j] == "<":
            return None  # never closed: not a tag
        if text[j] == "{":
            value, _, j = _read_value(text, j)
            if _SPREAD_ATTR.match("{" + value):
                spread = True
            continue
        if text[j] in "\"'":
            _, _, j = _read_value(text, j)
            continue
        attr = re.match(r"[^\s=>/\"']+|/", text[j:])
        if not attr:
            j += 1
            continue
        key = attr.group(0)
        j += len(key)
        if key == "/":
            continue
        k = j
        while k < n and text[k].isspace():
            k += 1
        if k < n and text[k] == "=":
            k += 1
            while k < n and text[k].isspace():
                k += 1
            value, expression, j = _read_value(text, k)
        else:
            value, expression = None, False
        plain, bound = _normalise(key)
        if plain in ("v-bind", "{...") or key.startswith("{..."):
            spread = True
            continue
        if plain:
            attrs[plain] = Attr(value, bound or expression)
    return None


def _opens_tag(text: str, i: int, js_like: bool) -> bool:
    if not js_like:
        return True
    k = i - 1
    while k >= 0 and text[k] in " \t\r":
        k -= 1
    if k < 0:
        return True
    if text[k] in _TAG_CONTEXT:
        return True
    return text[max(0, k - 5) : k + 1].endswith("return")


def _is_conditional(text: str, element: Element) -> bool:
    if any(a in _CONDITIONAL_ATTRS for a in element.attrs):
        return True
    before = text[max(0, element.start - 120) : element.start].rstrip()
    return bool(_CONDITIONAL_BLOCK.search(before.splitlines()[-1] if before else ""))


def parse(path: str, content: str) -> Markup:
    """Every element of ``content``, in document order, with its tree."""
    text = content
    for pattern in _COMMENTS:
        text = pattern.sub(_blank, text)
    js_like = path.lower().endswith(_JS_LIKE)
    elements: list[Element] = []
    stack: list[Element] = []
    i, n = 0, len(text)
    line, last = 1, 0
    while i < n:
        lt = text.find("<", i)
        if lt < 0:
            break
        if text.startswith("</", lt):
            close = re.match(r"</\s*([A-Za-z][\w.:-]*)?\s*>", text[lt:])
            if not close:
                i = lt + 1
                continue
            name = close.group(1) or ""
            for depth in range(len(stack) - 1, -1, -1):
                if not name or stack[depth].name.lower() == name.lower():
                    for open_el in stack[depth:]:
                        open_el.inner = text[open_el.open_end : lt]
                    del stack[depth:]
                    break
            i = lt + close.end()
            continue
        if not _opens_tag(text, lt, js_like):
            i = lt + 1
            continue
        tag = _read_tag(text, lt)
        if tag is None:
            i = lt + 1
            continue
        name, attrs, spread, self_closing, end = tag
        line += text.count("\n", last, lt)
        last = lt
        lowered = name.lower()
        element = Element(
            name=name if name[:1].isupper() or "." in name else lowered,
            attrs=attrs,
            line=line,
            start=lt,
            open_end=end,
            self_closing=self_closing,
            spread=spread,
            parent=stack[-1] if stack else None,
            source=" ".join(text[lt:end].split())[:160],
        )
        element.conditional = _is_conditional(text, element) or any(
            a.conditional for a in element.ancestors()
        )
        if element.parent is not None:
            element.parent.children.append(element)
        elements.append(element)
        i = end
        if self_closing or lowered in VOID_ELEMENTS:
            continue
        if lowered in _RAW_TEXT:
            close = re.search(rf"</\s*{re.escape(lowered)}\s*>", text[end:], re.I)
            stop = end + close.start() if close else n
            element.inner = text[end:stop]
            i = end + close.end() if close else n
            continue
        stack.append(element)
    for open_el in stack:
        open_el.inner = text[open_el.open_end :]
    return Markup(path=path, text=text, elements=elements, imports=_imports(content))

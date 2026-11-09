"""A translation key proposed for each hard-coded string, in the project's style (#346).

The key is built from where the string is and what it says, with no model:
``components/settings/PrivacyPanel.tsx`` + "Share anonymous benchmarks" →
``settings.privacyPanel.shareAnonymousBenchmarks``. The style follows the
catalogs the project already has (camelCase, snake_case or kebab-case leaves;
dots, or flat keys for Android, iOS, .NET and ARB), and a key that already
exists with the same text is reused rather than duplicated.

Interpolations are kept as the catalog's own placeholder: ``Hello {name}`` in
JSX becomes ``Hello {{name}}`` for i18next, ``{name}`` for ICU, ``%s`` for
Android and iOS. The snippet to paste is the stack's own call.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath

__all__ = ["KeyProposal", "KeyStyle", "detect_style", "propose_key", "snippet_for"]

_STOP_WORDS = frozenset(
    "a an the of to for and or at by with your our my is are be this that it you we "
    "le la les un une des de du et ou en au aux pour par sur avec votre vos notre nos est sont".split()
)
_PLURAL = re.compile(r"_(zero|one|two|few|many|other)$")
_SKIP_DIRS = frozenset(
    {"src", "app", "apps", "lib", "components", "component", "pages", "views", "view", "ui",
     "renderer", "frontend", "client", "web", "templates", "resources", "main", "java", "kotlin",
     "res", "layout", "screens", "features", "modules", "shared", "common"}
)  # fmt: skip


@dataclass(frozen=True)
class KeyStyle:
    case: str = "camel"
    """``camel``, ``snake`` or ``kebab``: the leaves of the existing keys."""
    nested: bool = True
    """Dotted keys (i18next, vue-i18n, Rails) or flat ones (Android, iOS, .NET, ARB)."""
    placeholder: str = "{{x}}"
    """How the catalogs write a placeholder: ``{{x}}``, ``{x}``, ``%s`` or ``:x``."""


@dataclass(frozen=True)
class KeyProposal:
    key: str
    value: str
    snippet: str
    reused: bool = False


def _words(text: str) -> list[str]:
    words = re.findall(r"[^\W_]+", text.lower())
    meaningful = [w for w in words if w not in _STOP_WORDS] or words
    return meaningful[:5]


def _join(words: list[str], case: str) -> str:
    if not words:
        return "text"
    if case == "snake":
        return "_".join(words)
    if case == "kebab":
        return "-".join(words)
    return words[0] + "".join(w[:1].upper() + w[1:] for w in words[1:])


def _segment(name: str, case: str) -> str:
    parts = re.findall(r"[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])", name)
    return _join([p.lower() for p in parts], case) if parts else ""


def detect_style(keys: list[str], catalog_format: str = "json") -> KeyStyle:
    """The style most of the existing keys follow."""
    flat = catalog_format in (
        "android",
        "strings",
        "resx",
        "arb",
        "properties",
        "gettext",
    )
    # ``files_one`` / ``files_other`` are i18next plural forms, not snake_case.
    leaves = [_PLURAL.sub("", k.rsplit(".", 1)[-1]) for k in keys[:2000]]
    snake = sum(1 for leaf in leaves if "_" in leaf and leaf.lower() == leaf)
    kebab = sum(1 for leaf in leaves if "-" in leaf)
    camel = sum(1 for leaf in leaves if re.search(r"[a-z][A-Z]", leaf))
    counts = {"camel": camel, "snake": snake, "kebab": kebab}
    case = max(counts, key=lambda c: counts[c])  # camel on a tie: first in order
    if flat and catalog_format in ("android", "arb") and not keys:
        case = "snake" if catalog_format == "android" else "camel"
    placeholder = {
        "android": "%s", "strings": "%@", "resx": "{0}", "properties": "{0}", "arb": "{x}",
        "gettext": "%s", "php": ":x", "yaml": "%{x}",
    }.get(catalog_format, "{{x}}")  # fmt: skip
    nested = not flat and (
        not keys or sum(1 for k in keys if "." in k) * 2 >= len(keys)
    )
    return KeyStyle(case=case, nested=nested, placeholder=placeholder)


_INTERPOLATION = re.compile(r"\$?\{\{?\s*([^{}]+?)\s*\}?\}")


def _with_placeholders(text: str, style: KeyStyle) -> str:
    """``Hello {name}`` / ``${name}`` / ``{{ name }}`` in the catalog's own placeholder form."""
    index = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal index
        expression = match.group(1).strip()
        name = re.sub(r"\W+", "_", expression.rsplit(".", 1)[-1]).strip("_") or "value"
        index += 1
        if style.placeholder == "{{x}}":
            return "{{" + name + "}}"
        if style.placeholder == "{x}":
            return "{" + name + "}"
        if style.placeholder == ":x":
            return ":" + name
        if style.placeholder == "%{x}":
            return "%{" + name + "}"
        if style.placeholder == "{0}":
            return "{" + str(index - 1) + "}"
        return style.placeholder  # %s, %@

    return _INTERPOLATION.sub(repl, text)


def propose_key(
    path: str,
    text: str,
    style: KeyStyle,
    existing: dict[str, str],
    taken: set[str],
) -> KeyProposal:
    """A key for ``text`` found in ``path``: reused when the catalog already has it."""
    value = _with_placeholders(text.strip(), style)
    for key, current in existing.items():
        if current == value:
            return KeyProposal(key, value, snippet_for(path, key), reused=True)
    parts: list[str] = []
    pure = PurePosixPath(path.replace("\\", "/"))
    for folder in pure.parent.parts[-3:]:
        if folder.lower() not in _SKIP_DIRS and not folder.startswith((".", "_", "(")):
            segment = _segment(folder, style.case)
            if segment and segment not in parts:
                parts.append(segment)
    stem = re.sub(
        r"\.(component|page|view|screen|vue|svelte|razor|cshtml|blade)$",
        "",
        pure.stem,
        flags=re.I,
    )
    stem_segment = _segment(stem, style.case)
    if (
        stem_segment
        and stem_segment not in ("index", "page", "default")
        and stem_segment not in parts
    ):
        parts.append(stem_segment)
    leaf = _join(_words(re.sub(r"\{\{?[^}]*\}?\}|%\w|:\w+", " ", value)), style.case)
    if style.nested:
        base = ".".join([*parts[-2:], leaf])
    else:
        # A flat key is one name: the component and the words, in the leaves' case.
        words = [
            w
            for p in parts[-1:]
            for w in re.findall(
                r"[A-Z]?[a-z0-9]+", p.replace("_", " ").replace("-", " ")
            )
        ]
        base = _join(
            [w.lower() for w in words]
            + _words(re.sub(r"\{\{?[^}]*\}?\}|%\w|:\w+", " ", value)),
            style.case,
        )
    key, n = base, 2
    while key in taken or key in existing:
        key, n = f"{base}{n}", n + 1
    taken.add(key)
    return KeyProposal(key, value, snippet_for(path, key))


def snippet_for(path: str, key: str) -> str:
    """The call that reads ``key`` in the file's stack."""
    suffix = PurePosixPath(path).suffix.lower()
    name = PurePosixPath(path).name.lower()
    if suffix in (".jsx", ".tsx", ".js", ".ts", ".astro"):
        return f'{{t("{key}")}}'
    if suffix == ".vue":
        return f"{{{{ $t('{key}') }}}}"
    if suffix == ".svelte":
        return f"{{$_('{key}')}}"
    if suffix in (".html", ".htm") and (
        name.endswith(".component.html") or "app" in path
    ):
        return f"{{{{ '{key}' | translate }}}}"
    if suffix in (".razor", ".cshtml"):
        return f'@Localizer["{key}"]'
    if suffix == ".xaml":
        return f"{{x:Static res:Strings.{key}}}"
    if suffix == ".php" or name.endswith(".blade.php"):
        return f"{{{{ __('{key}') }}}}"
    if suffix == ".twig":
        return f"{{{{ '{key}'|trans }}}}"
    if suffix == ".erb":
        return f"<%= t('{key}') %>"
    if suffix == ".hbs":
        return f'{{{{t "{key}"}}}}'
    if suffix == ".dart":
        return f"AppLocalizations.of(context)!.{key}"
    if suffix == ".swift":
        return f'String(localized: "{key}")'
    if suffix in (".kt", ".java"):
        return f"getString(R.string.{key})"
    if suffix == ".py":
        return f'_("{key}")'
    return f't("{key}")'

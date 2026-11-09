"""What a translation can get wrong besides being missing (#346).

Read from the catalogs ``catalogs.discover_catalogs`` returns, the same for
every format, with no model:

- **placeholders**: ``{{name}}``, ``{name}``, ``%s``/``%1$s``/``%d``, ``{0}``,
  ``:name`` (Laravel), ``%{name}`` (Rails), ``$name`` (Flutter ARB) must be the
  same set in every locale, or the app shows a raw placeholder or crashes;
- **untranslated**: a sentence (three words or more) copied from the reference
  locale unchanged. A short label that is the same in both languages
  ("Description", "Email", "OK") is not reported;
- **plurals**: each language needs its own plural categories (CLDR): Arabic
  six, Polish and Russian four, French and English two, Japanese one. A
  locale that lacks one of its categories, in i18next suffixes
  (``key_one``/``key_few``) or ICU messages (``{n, plural, one {…} …}``), shows
  the wrong form for some numbers;
- **right-to-left**: when a right-to-left locale ships (Arabic, Hebrew, Persian,
  Urdu…), styles that hard-code a side (``margin-left``, ``text-align: left``,
  Tailwind ``ml-4``, ``left-0``) do not mirror; logical properties do.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

__all__ = [
    "PLURAL_CATEGORIES",
    "RTL_LANGUAGES",
    "Finding",
    "flatten",
    "missing_plural_categories",
    "params_of",
    "physical_sides",
    "untranslated",
]

# CLDR 44 cardinal categories, by language (the part before - or _).
PLURAL_CATEGORIES: dict[str, frozenset[str]] = {}
for _langs, _cats in (
    ("ja zh ko vi th id ms lo my km yue bo dz ig ii jv kde kea ses sg to wo yo", "other"),
    ("en de nl sv da nb nn no fi et el hu tr bg ka af az eu gl hi bn ur ta te ml kn mr gu "
     "pa ne si sw zu xh ky kk uz mn ps so sq hy is ast fil", "one other"),
    ("fr pt it es ca", "one many other"),
    ("ru uk be", "one few many other"),
    ("pl", "one few many other"),
    ("cs sk", "one few many other"),
    ("lt", "one few many other"),
    ("lv", "zero one other"),
    ("ro mo", "one few other"),
    ("hr sr bs sh", "one few other"),
    ("sl", "one two few other"),
    ("he iw", "one two other"),
    ("ar", "zero one two few many other"),
    ("cy", "zero one two few many other"),
    ("ga", "one two few many other"),
    ("gd", "one two few other"),
    ("mt", "one two few many other"),
    ("fa", "one other"),
):  # fmt: skip
    for _lang in _langs.split():
        PLURAL_CATEGORIES[_lang] = frozenset(_cats.split())

# The plural "many" of fr/pt/it/es/ca is for large round numbers (1 000 000 de
# fichiers): i18next v21+ and ICU ask for it; a catalog that has neither it
# nor any other category beyond one/other predates it and is reported once as
# a warning, not on every key.
_OPTIONAL_MANY = frozenset({"fr", "pt", "it", "es", "ca"})

RTL_LANGUAGES = frozenset(
    {"ar", "he", "iw", "fa", "ur", "ps", "sd", "ug", "yi", "dv", "ckb", "ku"}
)

_CATEGORIES = ("zero", "one", "two", "few", "many", "other")
_SUFFIX = re.compile(r"^(?P<base>.+)_(?P<cat>zero|one|two|few|many|other)$")
_ICU_PLURAL = re.compile(r"\{\s*[\w.]+\s*,\s*plural\s*,", re.I)
_ICU_CASE = re.compile(r"(?:^|[\s}])(=?\d+|zero|one|two|few|many|other)\s*\{")

_PARAMS = (
    re.compile(r"\{\{\s*[-\w.]+\s*(?:,[^}]*)?\}\}"),  # i18next, Angular, Vue {{x}}
    re.compile(r"(?<![{$%])\{\s*[A-Za-z_][\w.]*\s*\}(?!\})"),  # ICU / vue-i18n {x}
    re.compile(r"\{\d+\}"),  # .NET, Java MessageFormat {0}
    re.compile(
        r"%(?:\d+\$)?[-+0#]*\d*(?:\.\d+)?[sdifuxXeEgGc@]"
    ),  # printf, iOS, Android
    re.compile(r"%\{\s*\w+\s*\}"),  # Rails %{name}
    re.compile(r"(?<![\w:]):[a-z_]\w*\b"),  # Laravel :name
)


@dataclass(frozen=True)
class Finding:
    kind: str
    """``params``, ``untranslated``, ``plural`` or ``rtl``."""
    locale: str
    key: str
    detail: str
    file: str = ""
    line: int = 0


def flatten(entries: object, prefix: str = "") -> dict[str, str]:
    """``{"a": {"b": "x"}}`` → ``{"a.b": "x"}``; non-strings are left out."""
    out: dict[str, str] = {}
    if isinstance(entries, dict):
        for key, value in entries.items():
            full = f"{prefix}.{key}" if prefix else str(key)
            if isinstance(value, dict):
                out.update(flatten(value, full))
            elif isinstance(value, str):
                out[full] = value
    return out


def params_of(text: str) -> frozenset[str]:
    """The placeholders of a message, spaces inside them ignored."""
    if _ICU_PLURAL.search(text):
        # The branches of an ICU plural differ on purpose; only the argument
        # names outside them must match.
        text = re.sub(
            r"\{\s*[\w.]+\s*,\s*(plural|select|selectordinal)\s*,.*",
            "",
            text,
            flags=re.S,
        )
    found = set()
    for pattern in _PARAMS:
        for match in pattern.finditer(text):
            found.add(re.sub(r"\s+", "", match.group(0)))
    return frozenset(found)


def untranslated(reference: str, target: str) -> bool:
    """A sentence copied unchanged from the reference locale."""
    if reference != target:
        return False
    words = re.findall(r"[^\W\d_]{2,}", reference)
    return len(words) >= 3


def _language(locale: str) -> str:
    return re.split(r"[-_]", locale.lower(), maxsplit=1)[0]


def _icu_categories(text: str) -> set[str] | None:
    if not _ICU_PLURAL.search(text):
        return None
    return {
        c for c in _ICU_CASE.findall(text) if not c.startswith("=") and not c.isdigit()
    }


def missing_plural_categories(
    locale: str, entries: dict[str, str]
) -> Iterator[tuple[str, str]]:
    """``(key, missing categories)`` for each plural message of ``locale``."""
    needed = PLURAL_CATEGORIES.get(_language(locale))
    if not needed:
        return
    language = _language(locale)
    groups: dict[str, set[str]] = {}
    for key in entries:
        match = _SUFFIX.match(key)
        if match:
            groups.setdefault(match.group("base"), set()).add(match.group("cat"))
    uses_many = any("many" in cats for cats in groups.values())
    for base, cats in sorted(groups.items()):
        wanted = set(needed)
        if language in _OPTIONAL_MANY and not uses_many:
            wanted.discard("many")
        missing = sorted(wanted - cats, key=_CATEGORIES.index)
        if missing:
            yield base, ", ".join(missing)
    for key, value in sorted(entries.items()):
        cats = _icu_categories(value)
        if cats is None:
            continue
        wanted = set(needed)
        if language in _OPTIONAL_MANY and "many" not in cats:
            wanted.discard("many")
        missing = sorted(wanted - cats, key=_CATEGORIES.index)
        if missing:
            yield key, ", ".join(missing)


_PHYSICAL_CSS = re.compile(
    r"\b(margin|padding|border)-(left|right)\s*:|(?<![-\w])(left|right)\s*:\s*[-\d.]|"
    r"text-align\s*:\s*(left|right)\b|float\s*:\s*(left|right)\b",
    re.I,
)
_PHYSICAL_CLASS = re.compile(
    r"(?<![\w:-])(?:[a-z]+:)*(ml|mr|pl|pr|left|right|text-left|text-right|float-left|float-right|"
    r"border-l|border-r|rounded-l|rounded-r)(?:-[\w.\[\]/]+)?(?![\w-])"
)
_CLASS_ATTR = re.compile(r"\b(?:class|className)\s*=\s*[\"'{`]([^\"'`}]+)")


def physical_sides(path: str, text: str, limit: int = 20) -> list[tuple[int, str]]:
    """``(line, what)`` for styles that do not mirror right to left."""
    found: list[tuple[int, str]] = []
    is_css = path.lower().endswith((".css", ".scss", ".sass", ".less", ".styl"))
    for number, line in enumerate(text.splitlines(), 1):
        if len(found) >= limit:
            break
        if is_css or "<style" in text:
            match = _PHYSICAL_CSS.search(line)
            if match:
                found.append((number, match.group(0).rstrip(": ").strip()))
                continue
        for attr in _CLASS_ATTR.finditer(line):
            match = _PHYSICAL_CLASS.search(attr.group(1))
            if match:
                found.append((number, match.group(0)))
                break
    return found

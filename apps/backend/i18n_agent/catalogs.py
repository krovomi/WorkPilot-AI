"""Translation catalogs and UI sources on every stack.

The i18n check compares each locale with the reference one. Only i18next JSON
folders used to count; this module reads the catalog format of each stack and
returns ``{locale: {catalog: {key: text}}}`` for the scanner:

- JSON folders (``locales/fr/*.json``) and files (``i18n/fr.json``)
- Flutter ARB (``app_fr.arb``), Angular XLIFF (``messages.fr.xlf``)
- .NET RESX (``Strings.resx`` is the neutral one, ``Strings.fr.resx``)
- Android ``res/values-fr/strings.xml``, iOS ``fr.lproj/Localizable.strings``
- gettext ``.po``, Java ``messages_fr.properties``, Rails YAML, Laravel ``lang/fr``

A neutral catalog (``Strings.resx``, ``values/strings.xml``,
``messages.properties``) belongs to the reference locale. Catalog files come
from the scanned repository: they are parsed as data, XML through defusedxml.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import yaml
from defusedxml import DefusedXmlException, ElementTree

# Sources whose UI text can be hard-coded, for every front-end and native stack.
SOURCE_EXTENSIONS = frozenset(
    {
        ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".html", ".htm",
        ".razor", ".cshtml", ".xaml", ".php", ".twig", ".erb", ".hbs",
        ".py", ".dart", ".swift", ".kt", ".java",
    }
)  # fmt: skip

SKIPPED_DIRS = frozenset(
    {
        "node_modules", ".git", "dist", "build", ".next", ".nuxt", "__pycache__",
        ".venv", "venv", ".workpilot", "out", "coverage", "bin", "obj", "target",
        "vendor", "Pods", ".dart_tool", ".gradle",
    }
)  # fmt: skip

_LOCALE = re.compile(r"^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$")
_MAX_BYTES = 2_000_000


def iter_files(root: Path, suffixes: frozenset[str] | None = None) -> list[Path]:
    """Files under ``root``, build and dependency folders pruned."""
    found: list[Path] = []
    for folder, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIPPED_DIRS]
        for name in names:
            path = Path(folder) / name
            if suffixes is None or path.suffix.lower() in suffixes:
                found.append(path)
    return found


def _locale(name: str) -> str | None:
    return name if _LOCALE.match(name) else None


def _read(path: Path) -> str | None:
    try:
        if path.stat().st_size > _MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def _json(text: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _xml_strings(text: str, tag: str, key_attr: str) -> dict[str, Any]:
    try:
        root = ElementTree.fromstring(text)
    except (ElementTree.ParseError, DefusedXmlException, ValueError):
        # A broken or hostile catalog is skipped, not fatal.
        return {}
    out: dict[str, Any] = {}
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] == tag and node.get(key_attr):
            out[node.get(key_attr)] = "".join(node.itertext()).strip()
    return out


_STRINGS_LINE = re.compile(r'^\s*"((?:[^"\\]|\\.)+)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;')
_PO_ID = re.compile(r'^msgid\s+"(.*)"\s*$')
_PROPERTY = re.compile(r"^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$")
_PHP_PAIR = re.compile(r"""['"]([\w.\-]+)['"]\s*=>\s*['"]""")


def _pairs(pattern: re.Pattern[str], text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in text.splitlines():
        match = pattern.match(line)
        if match:
            out[match.group(1)] = match.group(2) if pattern.groups > 1 else ""
    return out


def _po(text: str) -> dict[str, Any]:
    ids = (m.group(1) for line in text.splitlines() if (m := _PO_ID.match(line)))
    return {msgid: "" for msgid in ids if msgid}


def _php(text: str) -> dict[str, Any]:
    return dict.fromkeys(_PHP_PAIR.findall(text), "")


def _yaml(text: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


_I18N_DIRS = frozenset(
    {"i18n", "locales", "locale", "lang", "translations", "l10n", "messages"}
)


def _classify(path: Path, reference: str) -> tuple[str, str, dict[str, Any]] | None:
    """(locale, catalog name, entries) for a catalog file, or None."""
    name, parent = path.name, path.parent.name
    suffix = path.suffix.lower()
    text = None

    def load() -> str:
        nonlocal text
        if text is None:
            text = _read(path) or ""
        return text

    grand = path.parent.parent.name
    if suffix == ".json" and grand in _I18N_DIRS and (loc := _locale(parent)):
        return loc, path.stem, _json(load())
    if suffix == ".json" and parent in _I18N_DIRS and (loc := _locale(path.stem)):
        return loc, "messages", _json(load())
    if suffix == ".arb":
        loc = _locale(path.stem.rsplit("_", 1)[-1]) or _locale(path.stem)
        if loc:
            entries = {k: v for k, v in _json(load()).items() if not k.startswith("@")}
            return loc, "arb", entries
    if suffix == ".resx":
        stem, _, culture = path.stem.rpartition(".")
        if stem and _locale(culture):
            return culture, stem, _xml_strings(load(), "data", "name")
        return reference, path.stem, _xml_strings(load(), "data", "name")
    if name == "strings.xml" and parent.startswith("values"):
        qualifier = parent[len("values") :].lstrip("-").replace("-r", "-")
        if not qualifier or _locale(qualifier):
            return (
                qualifier or reference,
                "strings",
                _xml_strings(load(), "string", "name"),
            )
    if suffix == ".strings" and parent.endswith(".lproj"):
        loc = parent[: -len(".lproj")]
        loc = reference if loc == "Base" else _locale(loc)
        if loc:
            return loc, path.stem, _pairs(_STRINGS_LINE, load())
    if suffix in {".xlf", ".xliff"}:
        culture = path.stem.rpartition(".")[2]
        loc = _locale(culture) if "." in path.stem else reference
        if loc:
            return loc, "xliff", _xml_strings(load(), "trans-unit", "id")
    if suffix == ".po":
        loc = _locale(path.stem) or (
            _locale(path.parent.parent.name) if parent == "LC_MESSAGES" else None
        )
        if loc:
            return loc, "gettext", _po(load())
    if suffix == ".properties":
        stem, _, culture = path.stem.partition("_")
        if culture and _locale(culture):
            return culture, stem, _pairs(_PROPERTY, load())
        if stem in {"messages", "strings", "labels"} or stem.endswith("Bundle"):
            return reference, stem, _pairs(_PROPERTY, load())
    if suffix in {".yml", ".yaml"} and parent == "locales":
        data = _yaml(load())
        if len(data) == 1:
            ((loc, entries),) = data.items()
            if _locale(str(loc)) and isinstance(entries, dict):
                return str(loc), path.stem.split(".")[0], entries
    if suffix == ".php" and grand == "lang":
        if loc := _locale(parent):
            return loc, path.stem, _php(load())
    return None


_CATALOG_SUFFIXES = frozenset(
    {".json", ".arb", ".resx", ".xml", ".strings", ".xlf", ".xliff", ".po",
     ".properties", ".yml", ".yaml", ".php"}
)  # fmt: skip


def discover_catalogs(root: Path, reference: str = "en") -> dict[str, dict[str, Any]]:
    """``{locale: {catalog: entries}}`` for every catalog format found."""
    locales: dict[str, dict[str, Any]] = {}
    for path in iter_files(root, _CATALOG_SUFFIXES):
        if path.suffix.lower() == ".json" and path.name in {
            "package.json", "tsconfig.json", "composer.json", "package-lock.json",
        }:  # fmt: skip
            continue
        found = _classify(path, reference)
        if not found:
            continue
        locale, catalog, entries = found
        if entries:
            bucket = locales.setdefault(locale.replace("_", "-"), {})
            bucket.setdefault(catalog, {}).update(entries)
    return locales

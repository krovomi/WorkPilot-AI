"""i18n Auto-Scaling.

Reference workflow
------------------

1. **Diff** a target locale against the source — what keys are missing,
   what keys are obsolete (present in target but not source), and what
   keys are present in both with stale values.
2. **Generate** the missing-key skeleton: same shape as the source but
   values replaced by a placeholder (``[FR] Hello``).
3. **Coverage** report per locale: how complete is each, and which keys
   are still placeholders vs. real translations.

The default placeholder strategy uses ``[<LANG>]`` prefixes so missing
translations are immediately visible in the running app — better than
silent fallback to English.

Storage convention assumed
--------------------------

Each locale is one JSON file (or many JSON files in a folder), nested or
flat. We support both. Discovery layout matches WorkPilot's existing
``apps/frontend/src/shared/i18n/locales/<lang>/<namespace>.json``.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Helpers


def flatten(data: dict[str, Any], prefix: str = "") -> dict[str, str]:
    """Flatten a nested locale dict into ``{"a.b.c": "value"}``.

    Non-string leaves are coerced via ``str()``. Lists are turned into
    indexed paths (``a.0``, ``a.1``…).
    """
    out: dict[str, str] = {}
    for key, value in data.items():
        sub_key = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, sub_key))
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    out.update(flatten(item, f"{sub_key}.{i}"))
                else:
                    out[f"{sub_key}.{i}"] = str(item)
        else:
            out[sub_key] = "" if value is None else str(value)
    return out


def unflatten(flat: dict[str, str]) -> dict[str, Any]:
    """Inverse of `flatten` — build back a nested dict from dotted keys."""
    root: dict[str, Any] = {}
    for key, value in flat.items():
        parts = key.split(".")
        cursor: Any = root
        for i, part in enumerate(parts):
            is_last = i == len(parts) - 1
            if is_last:
                cursor[part] = value
            else:
                if part not in cursor or not isinstance(cursor[part], dict):
                    cursor[part] = {}
                cursor = cursor[part]
    return root


_INTERPOLATION_RE = re.compile(r"\{\{?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}?\}")


def _extract_placeholders(value: str) -> set[str]:
    """Return the set of ``{var}`` / ``{{var}}`` placeholder names in a string."""
    return set(_INTERPOLATION_RE.findall(value))


# ``en``, ``fr``, ``en-US``, ``pt_BR``, ``zh-Hans``, ``ckb``. Deliberately not
# a BCP-47 parser: the question is only whether a file or directory name reads
# as a language rather than as a namespace (``common``, ``navigation``).
_LOCALE_CODE_RE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$")


def _looks_like_locale_code(name: str) -> bool:
    """Does this file or directory name read as a locale code?"""
    return bool(_LOCALE_CODE_RE.match(name))


# ----------------------------------------------------------------------
# Models


class PlaceholderStrategy(str, Enum):
    """How to mark untranslated values in the generated locale skeleton."""

    LANG_PREFIX = "lang_prefix"  # "[FR] Hello"
    EMPTY = "empty"  # ""
    SOURCE_VALUE = "source_value"  # copy the source value verbatim
    MARKER = "marker"  # "__TRANSLATE_ME__"


@dataclass
class LocaleDiff:
    source_locale: str
    target_locale: str
    missing_keys: list[str] = field(default_factory=list)
    obsolete_keys: list[str] = field(default_factory=list)
    placeholder_mismatches: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "source_locale": self.source_locale,
            "target_locale": self.target_locale,
            "missing_keys": self.missing_keys,
            "obsolete_keys": self.obsolete_keys,
            "placeholder_mismatches": self.placeholder_mismatches,
            "totals": {
                "missing": len(self.missing_keys),
                "obsolete": len(self.obsolete_keys),
                "placeholder_mismatches": len(self.placeholder_mismatches),
            },
        }


@dataclass
class LocaleCoverage:
    locale: str
    total_keys: int
    translated_keys: int
    placeholder_keys: int

    @property
    def coverage_ratio(self) -> float:
        if self.total_keys == 0:
            return 0.0
        return self.translated_keys / self.total_keys

    def to_dict(self) -> dict:
        return {
            "locale": self.locale,
            "total_keys": self.total_keys,
            "translated_keys": self.translated_keys,
            "placeholder_keys": self.placeholder_keys,
            "coverage_ratio": round(self.coverage_ratio, 4),
        }


@dataclass
class LocaleDiscovery:
    """What was found on disk, and where it was actually read from.

    ``root`` is the directory the locales came from, which is not always the
    one that was asked for — see `I18nAutoScaler.discover_locales`. When they
    differ, ``redirected_from`` holds the directory that was asked for, so a
    caller can say which one it answered about instead of silently changing
    the subject.
    """

    root: Path
    layout: str  # "nested" | "flat" | "none"
    locales: dict[str, dict[str, Any]] = field(default_factory=dict)
    redirected_from: Path | None = None


@dataclass
class ScalingReport:
    source_locale: str
    diffs: list[LocaleDiff] = field(default_factory=list)
    coverage: list[LocaleCoverage] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "source_locale": self.source_locale,
            "diffs": [d.to_dict() for d in self.diffs],
            "coverage": [c.to_dict() for c in self.coverage],
        }


# ----------------------------------------------------------------------
# Scaler


class I18nAutoScaler:
    """Diff, scaffold and report on multi-locale translation files."""

    def __init__(
        self,
        placeholder_strategy: PlaceholderStrategy = PlaceholderStrategy.LANG_PREFIX,
        marker: str = "__TRANSLATE_ME__",
    ) -> None:
        self.placeholder_strategy = placeholder_strategy
        self.marker = marker

    # ------------------------------------------------------------------
    # Diff

    def diff(
        self,
        source: dict[str, Any],
        target: dict[str, Any],
        source_locale: str = "en",
        target_locale: str = "fr",
    ) -> LocaleDiff:
        """Compare a target locale dict against the source."""
        src_flat = flatten(source)
        tgt_flat = flatten(target)
        src_keys = set(src_flat.keys())
        tgt_keys = set(tgt_flat.keys())

        missing = sorted(src_keys - tgt_keys)
        obsolete = sorted(tgt_keys - src_keys)

        # Placeholder consistency: if EN says "Hello {name}" and FR says
        # "Bonjour {nom}" the variable names diverge — flag it.
        placeholder_mismatches = []
        for key in sorted(src_keys & tgt_keys):
            src_vars = _extract_placeholders(src_flat[key])
            tgt_vars = _extract_placeholders(tgt_flat[key])
            if src_vars != tgt_vars:
                placeholder_mismatches.append(key)

        return LocaleDiff(
            source_locale=source_locale,
            target_locale=target_locale,
            missing_keys=missing,
            obsolete_keys=obsolete,
            placeholder_mismatches=placeholder_mismatches,
        )

    # ------------------------------------------------------------------
    # Skeleton generation

    def generate_skeleton(
        self,
        source: dict[str, Any],
        target_locale: str,
        existing_target: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build a complete target locale dict with placeholders for new keys.

        Existing translated values in `existing_target` are preserved as-is.
        """
        src_flat = flatten(source)
        existing_flat = flatten(existing_target) if existing_target else {}
        out_flat: dict[str, str] = {}

        for key, src_value in src_flat.items():
            if key in existing_flat:
                out_flat[key] = existing_flat[key]
            else:
                out_flat[key] = self._make_placeholder(src_value, target_locale)

        return unflatten(out_flat)

    def _make_placeholder(self, source_value: str, target_locale: str) -> str:
        if self.placeholder_strategy == PlaceholderStrategy.LANG_PREFIX:
            return f"[{target_locale.upper()}] {source_value}"
        if self.placeholder_strategy == PlaceholderStrategy.EMPTY:
            return ""
        if self.placeholder_strategy == PlaceholderStrategy.SOURCE_VALUE:
            return source_value
        return self.marker

    # ------------------------------------------------------------------
    # Coverage

    def coverage(
        self,
        source: dict[str, Any],
        targets: dict[str, dict[str, Any]],
    ) -> list[LocaleCoverage]:
        """Compute coverage per target locale.

        A value counts as `translated` when (a) the key exists in the target
        AND (b) the value is not the placeholder we'd otherwise generate.
        """
        src_flat = flatten(source)
        result: list[LocaleCoverage] = []
        for locale, target in sorted(targets.items()):
            tgt_flat = flatten(target)
            translated = 0
            placeholder = 0
            for key, src_value in src_flat.items():
                if key not in tgt_flat:
                    continue
                if self._looks_like_placeholder(tgt_flat[key], src_value, locale):
                    placeholder += 1
                else:
                    translated += 1
            result.append(
                LocaleCoverage(
                    locale=locale,
                    total_keys=len(src_flat),
                    translated_keys=translated,
                    placeholder_keys=placeholder,
                )
            )
        return result

    def _looks_like_placeholder(
        self, value: str, source_value: str, target_locale: str
    ) -> bool:
        if not value:
            return True
        if value == self.marker:
            return True
        # `[FR] ...` style placeholders we generate.
        if re.match(rf"^\[{re.escape(target_locale.upper())}\]\s", value):
            return True
        # source_value strategy → identical value = untranslated heuristic.
        if (
            self.placeholder_strategy == PlaceholderStrategy.SOURCE_VALUE
            and value == source_value
        ):
            return True
        return False

    # ------------------------------------------------------------------
    # Filesystem helpers

    def discover_locales(self, locales_dir: Path | str) -> LocaleDiscovery:
        """Find the locales under `locales_dir`, whichever layout is in use.

        Two layouts are read, because both are ordinary i18next output and a
        folder picker gives no hint which one it just handed over:

        * **nested** — ``<root>/<lang>/*.json``, one file per namespace. A
          language is the merge of its namespace files, keyed by file stem.
        * **flat** — ``<root>/<lang>.json``, one file per language.

        And one directory is *not* a root at all: the locale directory
        itself. Picking ``locales/fr`` in the folder dialog is the obvious
        mistake to make — it is where the translations visibly are — and it
        used to read as an empty root, which then reported the source locale
        as missing from the very folder named after it. When the directory
        holds no locales but is itself named like one, the search moves up to
        its parent and says so in ``redirected_from``, so the answer names the
        directory it was actually read from.
        """
        root = Path(locales_dir)
        if not root.is_dir():
            raise ValueError(f"Not a directory: {root}")

        found = self._read_locales_at(root)
        if found.locales or not self._looks_like_locale_dir(root):
            return found

        parent = self._read_locales_at(root.parent)
        if not parent.locales:
            return found
        return LocaleDiscovery(
            root=parent.root,
            layout=parent.layout,
            locales=parent.locales,
            redirected_from=root,
        )

    def _read_locales_at(self, root: Path) -> LocaleDiscovery:
        """Read one directory as a locales root. No fallbacks, no redirect."""
        nested = self._read_nested_layout(root)
        if nested:
            return LocaleDiscovery(root=root, layout="nested", locales=nested)
        flat = self._read_flat_layout(root)
        if flat:
            return LocaleDiscovery(root=root, layout="flat", locales=flat)
        return LocaleDiscovery(root=root, layout="none", locales={})

    def _read_nested_layout(self, root: Path) -> dict[str, dict[str, Any]]:
        """``<root>/<lang>/*.json`` — every namespace file merged per language.

        A subdirectory counts as a language when its name reads like a locale
        code *or* it holds at least one ``.json`` file. The second half keeps
        an unusually named locale directory readable; the first keeps a
        sibling that merely sits next to the locales (``__generated__``,
        ``scripts``) from being reported as a language with no keys.
        """
        out: dict[str, dict[str, Any]] = {}
        try:
            children = sorted(p for p in root.iterdir() if p.is_dir())
        except OSError as e:
            logger.warning("Cannot list %s: %s", root, e)
            return {}

        for lang_dir in children:
            ns_files = sorted(lang_dir.glob("*.json"))
            if not ns_files and not _looks_like_locale_code(lang_dir.name):
                continue
            merged: dict[str, Any] = {}
            for ns_file in ns_files:
                payload = self._read_json(ns_file)
                if payload is not None:
                    merged[ns_file.stem] = payload
            out[lang_dir.name] = merged
        return out

    def _read_flat_layout(self, root: Path) -> dict[str, dict[str, Any]]:
        """``<root>/<lang>.json`` — one file per language, no namespaces.

        Accepted only when *every* JSON file directly under the root is named
        like a locale code. A namespace directory such as ``locales/fr`` also
        holds JSON files, and a couple of those stems (``no``, ``llm``) read
        like locale codes on their own — taking the layout on a partial match
        would report a handful of namespaces as languages.
        """
        try:
            json_files = sorted(root.glob("*.json"))
        except OSError as e:
            logger.warning("Cannot list %s: %s", root, e)
            return {}
        if not json_files:
            return {}
        if not all(_looks_like_locale_code(f.stem) for f in json_files):
            return {}

        out: dict[str, dict[str, Any]] = {}
        for f in json_files:
            payload = self._read_json(f)
            if payload is not None:
                out[f.stem] = payload
        return out

    def _looks_like_locale_dir(self, root: Path) -> bool:
        """Is this the inside of one language rather than the root of all of them?"""
        if not _looks_like_locale_code(root.name):
            return False
        try:
            return any(root.glob("*.json"))
        except OSError:
            return False

    @staticmethod
    def _read_json(path: Path) -> dict[str, Any] | None:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("Skipping %s: %s", path, e)
            return None

    def discover_locale_dir(self, locales_dir: Path | str) -> dict[str, dict[str, Any]]:
        """`discover_locales`, keeping only the locales. See it for the layouts."""
        return self.discover_locales(locales_dir).locales

    def write_skeleton_to_dir(
        self,
        skeleton: dict[str, Any],
        locale_dir: Path | str,
        namespaces: Iterable[str] | None = None,
    ) -> list[Path]:
        """Write a skeleton dict to disk as ``<locale_dir>/<ns>.json`` files.

        Only writes files for top-level keys present in `namespaces`
        (default: every top-level key).
        """
        target = Path(locale_dir)
        target.mkdir(parents=True, exist_ok=True)
        ns_filter = set(namespaces) if namespaces is not None else None
        written: list[Path] = []
        for ns, payload in skeleton.items():
            if ns_filter is not None and ns not in ns_filter:
                continue
            path = target / f"{ns}.json"
            path.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            written.append(path)
        return written

    # ------------------------------------------------------------------
    # All-in-one

    def report(
        self,
        source_locale: str,
        locales: dict[str, dict[str, Any]],
    ) -> ScalingReport:
        """Compute a full diff + coverage report."""
        if source_locale not in locales:
            raise ValueError(f"Source locale {source_locale!r} not in locales")
        source = locales[source_locale]

        diffs = [
            self.diff(source, target, source_locale=source_locale, target_locale=lang)
            for lang, target in sorted(locales.items())
            if lang != source_locale
        ]
        coverage = self.coverage(
            source,
            {lang: t for lang, t in locales.items() if lang != source_locale},
        )
        return ScalingReport(
            source_locale=source_locale, diffs=diffs, coverage=coverage
        )

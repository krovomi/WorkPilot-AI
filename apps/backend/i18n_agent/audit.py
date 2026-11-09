"""The whole i18n report, and translating what is missing (#346).

``audit`` puts together what the other modules find, with no model:
hard-coded strings with a proposed key and the snippet to paste, missing and
obsolete keys, orphan keys no source names, copies of the reference text,
placeholders that differ, plural forms a language lacks, styles that do not
mirror when a right-to-left locale ships, and a completeness score per locale.

``translate_catalogs`` is the only step that calls a model. It runs in the
review worktree WorkPilot opens for it, adds the missing keys of each
catalog it can write (``writers.WRITABLE_FORMATS``) and leaves the others
listed, so the person reviews the diff before anything reaches the project.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .catalogs import (
    SOURCE_EXTENSIONS,
    CatalogFile,
    catalog_files,
    discover_catalogs,
    entries_of,
    iter_files,
)
from .i18n_scanner import (
    I18nIssue,
    I18nIssueType,
    I18nScanner,
    I18nSeverity,
    _plural_not_needed,
    is_ui_file,
)
from .keys import detect_style, propose_key
from .parity import (
    _OPTIONAL_MANY,
    RTL_LANGUAGES,
    flatten,
    missing_plural_categories,
    params_of,
    physical_sides,
    untranslated,
)
from .translator import MAX_KEYS, translate
from .usage import collect_usage
from .writers import WRITABLE_FORMATS, add_entries

__all__ = ["audit", "issue_to_dict", "translate_catalogs"]

_STYLE_SUFFIXES = frozenset({".css", ".scss", ".sass", ".less", ".styl"})
_CAP = 500
_RTL_CAP = 100
_PLURAL = re.compile(r"_(zero|one|two|few|many|other)$")

# What to write instead of a physical side, for right-to-left.
_LOGICAL = {
    "margin-left": "margin-inline-start", "margin-right": "margin-inline-end",
    "padding-left": "padding-inline-start", "padding-right": "padding-inline-end",
    "border-left": "border-inline-start", "border-right": "border-inline-end",
    "left": "inset-inline-start", "right": "inset-inline-end",
    "ml": "ms", "mr": "me", "pl": "ps", "pr": "pe", "text-left": "text-start",
    "text-right": "text-end", "float-left": "float-start", "float-right": "float-end",
    "border-l": "border-s", "border-r": "border-e", "rounded-l": "rounded-s",
    "rounded-r": "rounded-e",
}  # fmt: skip


def _language(locale: str) -> str:
    return re.split(r"[-_]", locale.lower(), maxsplit=1)[0]


def issue_to_dict(issue: I18nIssue) -> dict[str, Any]:
    return {
        "issueType": issue.issue_type.value,
        "severity": issue.severity.value,
        "file": issue.file,
        "line": issue.line,
        "key": issue.key,
        "locale": issue.locale,
        "message": issue.message,
        "suggestion": issue.suggestion,
        "text": issue.text,
        "proposedKey": issue.proposed_key,
        "proposedValue": issue.proposed_value,
        "snippet": issue.snippet,
        "reused": issue.reused,
        "possibly": issue.possibly,
    }


def _logical(found: str) -> str:
    match = re.search(r"(?:[a-z]+:)*([a-z-]+?)(?:-[\w.\[\]/]+)?$", found)
    name = (
        found.split(":")[0].strip()
        if ":" in found and "-" in found.split(":")[0]
        else found
    )
    for candidate in (name.split()[0] if name else "", match.group(1) if match else ""):
        if candidate in _LOGICAL:
            return _LOGICAL[candidate]
    if found.startswith(("text-align", "float")):
        return found.replace("left", "start").replace("right", "end")
    return ""


def _files_by_catalog(
    files: list[CatalogFile], root: Path
) -> dict[tuple[str, str], str]:
    out: dict[tuple[str, str], str] = {}
    for file in files:
        out.setdefault(
            (file.locale, file.catalog), file.path.relative_to(root).as_posix()
        )
    return out


def _flat_catalogs(
    locales: dict[str, dict[str, Any]],
) -> dict[str, dict[str, dict[str, str]]]:
    return {
        loc: {cat: flatten(entries) for cat, entries in cats.items()}
        for loc, cats in locales.items()
    }


def _params_without_count(key: str, text: str) -> frozenset[str]:
    # An English "One file" may drop the count a French "{{count}} fichier" keeps.
    found = params_of(text)
    if _PLURAL.search(key):
        found = frozenset(p for p in found if "count" not in p)
    return found


def _hardcoded(
    root: Path,
    sources: dict[str, str],
    scanner: I18nScanner,
    main: tuple[str, str, dict[str, str]] | None,
) -> list[I18nIssue]:
    issues: list[I18nIssue] = []
    for rel, text in sources.items():
        issues.extend(scanner.scan_file_for_hardcoded(rel, text))
    if not issues:
        return issues
    catalog, fmt, existing = main or ("messages", "json", {})
    style = detect_style(list(existing), fmt)
    taken: set[str] = set()
    for issue in issues:
        proposal = propose_key(issue.file, issue.text, style, existing, taken)
        issue.proposed_key = proposal.key
        issue.proposed_value = proposal.value
        issue.snippet = proposal.snippet
        issue.reused = proposal.reused
        issue.key = proposal.key
        issue.suggestion = (
            f"Use the existing key {proposal.key}"
            if proposal.reused
            else f"Add {proposal.key} to the {catalog} catalog"
        )
    return issues


def _orphans(
    reference: str,
    flat: dict[str, dict[str, str]],
    sources: dict[str, str],
    where: dict[tuple[str, str], str],
) -> list[I18nIssue]:
    usage = collect_usage(sources)
    if not usage.keys and not usage.prefixes:
        return []  # no source names any key: the catalogs live elsewhere
    issues: list[I18nIssue] = []
    for catalog, entries in sorted(flat.items()):
        for key in sorted(entries):
            if usage.uses(key, catalog):
                continue
            issues.append(
                I18nIssue(
                    issue_type=I18nIssueType.ORPHAN_KEY,
                    severity=I18nSeverity.INFO,
                    file=where.get((reference, catalog), ""),
                    key=f"{catalog}.{key}",
                    locale=reference,
                    possibly=usage.dynamic,
                    message=(
                        f"No source names '{key}' (some keys are built at run time: check before deleting)"
                        if usage.dynamic
                        else f"No source names '{key}'"
                    ),
                    suggestion="Remove it from every locale, or use it",
                )
            )
    return issues


def _parity(
    reference: str,
    flat: dict[str, dict[str, dict[str, str]]],
    where: dict[tuple[str, str], str],
) -> tuple[list[I18nIssue], dict[str, int]]:
    issues: list[I18nIssue] = []
    copied: dict[str, int] = {}
    ref = flat.get(reference, {})
    for locale, catalogs in sorted(flat.items()):
        same_language = _language(locale) == _language(reference)
        for catalog, entries in catalogs.items():
            base = ref.get(catalog, {})
            for key, text in entries.items():
                source = base.get(key)
                if not source or not text or locale == reference:
                    continue
                file = where.get((locale, catalog), "")
                if _params_without_count(key, source) != _params_without_count(
                    key, text
                ):
                    issues.append(
                        I18nIssue(
                            issue_type=I18nIssueType.INCONSISTENT_PARAMS,
                            severity=I18nSeverity.ERROR,
                            file=file,
                            key=f"{catalog}.{key}",
                            locale=locale,
                            text=(
                                f"{' '.join(sorted(params_of(source))) or '∅'} → "
                                f"{' '.join(sorted(params_of(text))) or '∅'}"
                            ),
                            message=(
                                f"Placeholders differ: {', '.join(sorted(params_of(source))) or 'none'} in "
                                f"{reference}, {', '.join(sorted(params_of(text))) or 'none'} in {locale}"
                            ),
                            suggestion="Use the same placeholders as the reference text",
                        )
                    )
                if not same_language and untranslated(source, text):
                    copied[locale] = copied.get(locale, 0) + 1
                    issues.append(
                        I18nIssue(
                            issue_type=I18nIssueType.UNTRANSLATED,
                            severity=I18nSeverity.WARNING,
                            file=file,
                            key=f"{catalog}.{key}",
                            locale=locale,
                            text=source,
                            message=f'Same text as {reference}: "{source[:60]}"',
                            suggestion=f"Translate it into {locale}",
                        )
                    )
    return issues, copied


def _plurals(
    flat: dict[str, dict[str, dict[str, str]]], where: dict[tuple[str, str], str]
) -> list[I18nIssue]:
    issues: list[I18nIssue] = []
    for locale, catalogs in sorted(flat.items()):
        joined = {
            f"{cat}.{k}": v
            for cat, entries in catalogs.items()
            for k, v in entries.items()
        }
        for key, missing in missing_plural_categories(locale, joined):
            catalog = key.split(".", 1)[0]
            issues.append(
                I18nIssue(
                    issue_type=I18nIssueType.MISSING_PLURAL,
                    severity=I18nSeverity.WARNING,
                    file=where.get((locale, catalog), ""),
                    key=key,
                    locale=locale,
                    text=missing,
                    message=f"{locale} needs the plural forms {missing}",
                    suggestion=f"Add {', '.join(f'{key.split(".", 1)[-1]}_{m.strip()}' for m in missing.split(','))}"
                    if "{" not in joined.get(key, "")
                    else "Add the missing branches to the plural message",
                )
            )
        language = _language(locale)
        has_groups = any(_PLURAL.search(k) for k in joined)
        if (
            language in _OPTIONAL_MANY
            and has_groups
            and not any(k.endswith("_many") for k in joined)
        ):
            issues.append(
                I18nIssue(
                    issue_type=I18nIssueType.MISSING_PLURAL,
                    severity=I18nSeverity.INFO,
                    file="",
                    locale=locale,
                    message=f"{locale} has no _many form: recent i18next and ICU use it for large round numbers",
                    suggestion="Add _many next to _other where a count can reach a million",
                )
            )
    return issues


def _rtl(root: Path, sources: dict[str, str], rtl: list[str]) -> list[I18nIssue]:
    if not rtl:
        return []
    texts = dict(sources)
    for path in iter_files(root, _STYLE_SUFFIXES):
        rel = path.relative_to(root).as_posix()
        if rel not in texts and is_ui_file(rel):
            try:
                texts[rel] = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
    issues: list[I18nIssue] = []
    for rel, text in sorted(texts.items()):
        for line, found in physical_sides(rel, text):
            logical = _logical(found)
            issues.append(
                I18nIssue(
                    issue_type=I18nIssueType.RTL_SIDE,
                    severity=I18nSeverity.WARNING,
                    file=rel,
                    line=line,
                    text=found,
                    proposed_value=logical,
                    message=f"{found} does not mirror for {', '.join(rtl)}",
                    suggestion=f"Use {logical}"
                    if logical
                    else "Use a logical property (start/end)",
                )
            )
            if len(issues) >= _RTL_CAP:
                return issues
    return issues


def _read_sources(root: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for path in iter_files(
        root,
        SOURCE_EXTENSIONS | {".js", ".ts", ".mjs", ".cs", ".rb", ".go", ".rs", ".m"},
    ):
        try:
            if path.stat().st_size > 1_000_000:
                continue
            out[path.relative_to(root).as_posix()] = path.read_text(
                encoding="utf-8", errors="ignore"
            )
        except OSError:
            continue
    return out


def audit(
    root: Path, reference: str = "en", emit: Callable[[str], None] | None = None
) -> dict[str, Any]:
    """The i18n report of the project at ``root``."""
    say = emit or (lambda _status: None)
    say("Reading sources and catalogs...")
    sources = _read_sources(root)
    ui_sources = {
        rel: text
        for rel, text in sources.items()
        if Path(rel).suffix.lower() in SOURCE_EXTENSIONS
    }
    files = catalog_files(root, reference)
    locales = discover_catalogs(root, reference)
    flat = _flat_catalogs(locales)
    where = _files_by_catalog(files, root)
    scanner = I18nScanner(reference_locale=reference)

    main = None
    ref_catalogs = flat.get(reference, {})
    if ref_catalogs:
        catalog = max(ref_catalogs, key=lambda c: len(ref_catalogs[c]))
        fmt = next(
            (f.format for f in files if f.locale == reference and f.catalog == catalog),
            "json",
        )
        main = (catalog, fmt, ref_catalogs[catalog])

    say(f"Looking for hard-coded strings in {len(ui_sources)} files...")
    issues = _hardcoded(root, ui_sources, scanner, main)

    say("Comparing locales...")
    coverage: dict[str, float] = {}
    if reference in locales and len(locales) > 1:
        for locale, data in sorted(locales.items()):
            if locale == reference:
                continue
            for issue in scanner.compare_locale_files(locales[reference], data, locale):
                catalog = issue.key.split(".", 1)[0]
                issue.file = where.get((locale, catalog), issue.file)
                issues.append(issue)
        coverage = {
            k: round(v * 100, 1)
            for k, v in scanner.compute_coverage(locales[reference], locales).items()
        }

    parity, copied = _parity(reference, flat, where)
    issues.extend(parity[:_CAP] if len(parity) > _CAP else parity)
    issues.extend(_plurals(flat, where)[:_CAP])

    say("Looking for keys no source uses...")
    issues.extend(_orphans(reference, ref_catalogs, sources, where)[:_CAP])

    rtl = sorted(loc for loc in locales if _language(loc) in RTL_LANGUAGES)
    if rtl:
        say("Checking right-to-left layout...")
    issues.extend(_rtl(root, ui_sources, rtl))

    completeness = []
    writable = {(f.locale, f.catalog) for f in files if f.format in WRITABLE_FORMATS}
    translatable: dict[str, int] = {}
    ref_flat = {f"{c}.{k}" for c, entries in ref_catalogs.items() for k in entries}
    for locale in sorted(flat):
        if locale == reference:
            continue
        mine = {f"{c}.{k}" for c, entries in flat[locale].items() for k in entries}
        wanted = [k for k in ref_flat if not _plural_not_needed(k, locale)]
        present = sum(1 for k in wanted if k in mine)
        missing = [k for k in wanted if k not in mine]
        translatable[locale] = sum(
            1 for k in missing if (locale, k.split(".", 1)[0]) in writable
        )
        done = present - copied.get(locale, 0)
        completeness.append(
            {
                "locale": locale,
                "total": len(wanted),
                "present": present,
                "untranslated": copied.get(locale, 0),
                "missing": len(missing),
                "score": round(100 * done / len(wanted), 1) if wanted else 100.0,
                "rtl": locale in rtl,
            }
        )

    by_type: dict[str, int] = {}
    for issue in issues:
        by_type[issue.issue_type.value] = by_type.get(issue.issue_type.value, 0) + 1
    return {
        "filesScanned": len(ui_sources),
        "referenceLocale": reference,
        "localesCompared": sorted(locales),
        "issues": [issue_to_dict(i) for i in issues],
        "coverageByLocale": coverage,
        "completeness": completeness,
        "countsByType": by_type,
        "rtlLocales": rtl,
        "translatable": translatable,
        "catalogFormats": sorted({f.format for f in files}),
        "summary": ", ".join(f"{c} {t}" for t, c in sorted(by_type.items()))
        or "No issues",
    }


def _reference_for(
    target: CatalogFile, files: list[CatalogFile], reference: str
) -> CatalogFile | None:
    """The reference file ``target`` translates: same catalog and format, closest path."""
    candidates = [
        f
        for f in files
        if f.locale == reference
        and f.catalog == target.catalog
        and f.format == target.format
    ]
    if not candidates:
        return None

    def shared(f: CatalogFile) -> int:
        n = 0
        for a, b in zip(f.path.parts, target.path.parts, strict=False):
            if a != b:
                break
            n += 1
        return n

    return max(candidates, key=shared)


def translate_catalogs(
    root: Path,
    reference: str = "en",
    locales: list[str] | None = None,
    ask: Callable[[str, str | None], str] | None = None,
) -> dict[str, Any]:
    """Add each locale's missing keys, translated and checked, to the catalogs it can write."""
    files = catalog_files(root, reference)
    written: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    not_writable: set[str] = set()
    answered = False
    budget = MAX_KEYS
    skipped = 0
    for target in sorted(files, key=lambda f: (f.locale, str(f.path))):
        if target.locale == reference or (locales and target.locale not in locales):
            continue
        source = _reference_for(target, files, reference)
        if source is None:
            continue
        ref_entries = flatten(entries_of(source, reference))
        mine = set(flatten(entries_of(target, reference)))
        missing = {
            k: v
            for k, v in ref_entries.items()
            if k not in mine and v and not _plural_not_needed(k, target.locale)
        }
        if not missing:
            continue
        rel = target.path.relative_to(root).as_posix()
        if target.format not in WRITABLE_FORMATS or target.path.is_symlink():
            not_writable.add(rel)
            continue
        if budget <= 0:
            skipped += len(missing)
            continue
        batch = dict(list(missing.items())[:budget])
        skipped += len(missing) - len(batch)
        result = translate(
            batch, reference, target.locale, target.catalog, str(root), ask=ask
        )
        budget -= len(batch)
        answered = answered or result.answered
        rejected.extend(
            {"locale": target.locale, "key": k, "reason": r}
            for k, r in result.rejected.items()
        )
        if result.translated:
            added = add_entries(target.path, target.format, result.translated, mine)
            if added:
                written.append(
                    {"file": rel, "locale": target.locale, "count": len(added)}
                )
    return {
        "written": written,
        "added": sum(w["count"] for w in written),
        "rejected": len(rejected),
        "rejectedSample": rejected[:20],
        "skipped": skipped,
        "answered": answered,
        "notWritable": sorted(not_writable),
    }

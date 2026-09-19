"""Reading and writing the translation files themselves.

`scaler.py` answers *what is wrong* with a set of locales — which keys are
missing, which are placeholders, where the interpolation variables diverge.
It never writes anything back. This module is the other half: the one that
edits the files, so the answer to "``kanban:board.empty`` is missing in fr"
can be *fixing it* rather than opening an editor and finding the line.

Three things make that safe enough to do from a UI.

**A key is edited where it lives.** In the nested layout a key belongs to one
namespace file per locale — ``<root>/<locale>/<namespace>.json``. The unit of
work here is therefore one namespace across every locale at once, which is
also the unit a translator thinks in. The flat layout (``<root>/<locale>.json``)
has no namespaces; it is read as the single namespace ``""``.

**A file is rewritten in its own style.** These are source files under version
control, and a save that reindents 3 000 lines is a diff nobody can review.
`detect_indent` reads the style back out of the file and `dump_json` writes it
again, so an edit to one string is a one-line diff.

**A save refuses to clobber.** Every load returns a fingerprint per file, and
`apply_operations` checks it before writing. Without that, two tabs open on the
same namespace — or an editor open beside the app — silently lose whichever
save lands second.

Writes are atomic: a temporary file in the same directory, then `os.replace`.
A crash mid-save leaves the original translation file intact rather than half
of it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .scaler import (
    I18nAutoScaler,
    LocaleDiscovery,
    _extract_placeholders,
    flatten,
    unflatten,
)

logger = logging.getLogger(__name__)

# The namespace name for a flat layout, where the locale file *is* the
# namespace. Empty rather than something like "default" so it cannot collide
# with a real namespace called "default".
FLAT_NAMESPACE = ""

#: A key path: dot-separated segments, each non-empty. Rejects the shapes that
#: `unflatten` cannot round-trip — a leading, trailing or doubled dot would
#: produce an empty object key that no `t()` call can name.
_KEY_RE = re.compile(r"^[^.\s][^.]*(?:\.[^.\s][^.]*)*$")

MAX_KEY_LEN = 512
MAX_VALUE_LEN = 20_000


class EditorError(ValueError):
    """A refusal the caller can act on.

    It carries a `reason` code and the handful of **safe** values that go with
    it — a key the caller sent, a locale code, a file's basename — and never a
    resolved path or another exception's text. `api.py` renders the sentence
    from a literal table keyed on `reason`, the shape `workflows/api.py` uses
    and that `core.api_safety` recommends "when the set of rejections is small
    and known".

    Rendering there rather than here is what keeps the message out of the
    exception: `safe_error` exists because an exception's own text reaching a
    response is `py/stack-trace-exposure`, and CodeQL was right to say so of
    the version of this module that returned `str(e)`. Two of those messages
    really did carry a resolved filesystem path.

    The `str()` form stays useful for the log and for tests; it is not what a
    caller is shown.
    """

    def __init__(self, reason: str, message: str, **params: object) -> None:
        super().__init__(message)
        self.reason = reason
        self.params = params


class StaleFileError(EditorError):
    """A file changed on disk since it was loaded, so the save was not applied."""

    def __init__(self, message: str, **params: object) -> None:
        super().__init__("stale-file", message, **params)


# ----------------------------------------------------------------------
# File style


def detect_indent(raw: str) -> str | int:
    """The indentation the file already uses, in the form `json.dump` wants.

    Returns ``"\\t"`` for a tab-indented file, or the number of spaces. The
    default is two spaces, which is what `json.dump(indent=2)` produces and
    what this repository's own generated JSON uses.

    Guessing wrong is not cosmetic. These files are committed, and a save that
    converts 101 tab-indented namespaces to spaces turns a one-word
    translation fix into a diff nobody will read.
    """
    for line in raw.splitlines()[1:]:
        if not line.strip():
            continue
        if line.startswith("\t"):
            return "\t"
        stripped = line.lstrip(" ")
        spaces = len(line) - len(stripped)
        if spaces:
            return spaces
        # A non-indented, non-empty line before any indented one means the
        # document has no nesting to learn from. Keep looking.
    return 2


def dump_json(data: dict[str, Any], indent: str | int, trailing_newline: bool) -> str:
    """Serialise in the file's own style.

    ``ensure_ascii=False`` because these files are full of accented French and
    escaping it to ``\\u00e9`` would rewrite every line of every file on the
    first save.
    """
    text = json.dumps(data, indent=indent, ensure_ascii=False)
    return text + "\n" if trailing_newline else text


def fingerprint(raw: str) -> str:
    """What a save checks to know the file is the one that was loaded."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ----------------------------------------------------------------------
# Models


@dataclass
class NamespaceSummary:
    """One namespace, and how much of it is done in each locale."""

    namespace: str
    total_keys: int
    translated: dict[str, int] = field(default_factory=dict)
    missing: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "namespace": self.namespace,
            "total_keys": self.total_keys,
            "translated": self.translated,
            "missing": self.missing,
        }


@dataclass
class Entry:
    """One key, and its value in each locale.

    ``None`` is not the empty string. A key absent from ``fr`` is untranslated;
    a key present with ``""`` is a deliberate blank, which some strings are.
    The UI draws them differently and the writer preserves the difference.
    """

    key: str
    values: dict[str, str | None] = field(default_factory=dict)
    placeholder_mismatch: bool = False

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "values": self.values,
            "placeholder_mismatch": self.placeholder_mismatch,
        }


@dataclass
class NamespaceView:
    """Everything the editor needs to show one namespace, and to save it back."""

    namespace: str
    locales: list[str]
    entries: list[Entry]
    fingerprints: dict[str, str]
    root: str

    def to_dict(self) -> dict:
        return {
            "namespace": self.namespace,
            "locales": self.locales,
            "entries": [e.to_dict() for e in self.entries],
            "fingerprints": self.fingerprints,
            "root": self.root,
        }


OpName = Literal["set", "add", "rename", "delete"]


@dataclass
class Operation:
    """One edit. `set` and `add` differ only in what they assert already exists."""

    op: OpName
    key: str
    new_key: str | None = None
    values: dict[str, str | None] = field(default_factory=dict)


# ----------------------------------------------------------------------
# Paths


def locale_file(root: Path, locale: str, namespace: str) -> Path:
    """Where this (locale, namespace) lives on disk."""
    if namespace == FLAT_NAMESPACE:
        return root / f"{locale}.json"
    return root / locale / f"{namespace}.json"


def _read(path: Path) -> tuple[dict[str, Any], str]:
    """The file's parsed content and its raw text. Missing reads as empty."""
    if not path.is_file():
        return {}, ""
    raw = path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        raise EditorError(
            "invalid-json",
            f"{path.name} is not valid JSON ({e.msg}, line {e.lineno}).",
            file=path.name,
        ) from None
    if not isinstance(data, dict):
        raise EditorError(
            "not-an-object",
            f"{path.name} does not hold a JSON object.",
            file=path.name,
        )
    return data, raw


def _write_atomic(path: Path, text: str) -> None:
    """Replace the file in one step, or leave it exactly as it was.

    The temporary file is created in the same directory so `os.replace` stays
    on one filesystem — across devices it is not atomic and can fail outright.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ----------------------------------------------------------------------
# Reading


def _namespaces_of(discovery: LocaleDiscovery) -> list[str]:
    if discovery.layout == "flat":
        return [FLAT_NAMESPACE]
    names: set[str] = set()
    for payload in discovery.locales.values():
        names.update(payload.keys())
    return sorted(names)


def _flat_for(
    discovery: LocaleDiscovery, locale: str, namespace: str
) -> dict[str, str]:
    payload = discovery.locales.get(locale) or {}
    if namespace == FLAT_NAMESPACE:
        return flatten(payload)
    section = payload.get(namespace)
    return flatten(section) if isinstance(section, dict) else {}


def list_namespaces(
    locales_dir: Path | str, scaler: I18nAutoScaler | None = None
) -> tuple[LocaleDiscovery, list[NamespaceSummary]]:
    """Every namespace, with a per-locale count of what is done and what is not.

    The counts are what the editor's sidebar draws. They are computed here, in
    one pass over the already-loaded locales, rather than per namespace on
    demand: a sidebar that fills in one row at a time as you scroll is a
    sidebar you cannot sort by "least complete".
    """
    scaler = scaler or I18nAutoScaler()
    discovery = scaler.discover_locales(locales_dir)
    locales = sorted(discovery.locales)
    out: list[NamespaceSummary] = []

    for namespace in _namespaces_of(discovery):
        per_locale = {loc: _flat_for(discovery, loc, namespace) for loc in locales}
        keys: set[str] = set()
        for flat in per_locale.values():
            keys.update(flat)
        summary = NamespaceSummary(namespace=namespace, total_keys=len(keys))
        for loc in locales:
            flat = per_locale[loc]
            present = [k for k in keys if k in flat]
            translated = sum(
                1
                for k in present
                if not scaler._looks_like_placeholder(flat[k], flat[k], loc)
            )
            summary.translated[loc] = translated
            summary.missing[loc] = len(keys) - len(present)
        out.append(summary)
    return discovery, out


def load_namespace(
    locales_dir: Path | str,
    namespace: str,
    scaler: I18nAutoScaler | None = None,
    reference_locale: str | None = None,
) -> NamespaceView:
    """One namespace across every locale, plus the fingerprints a save needs.

    `reference_locale` decides whose interpolation variables the others are
    compared against. With none given the first locale alphabetically is used,
    which is arbitrary but stable — and the caller (the panel) always passes
    the source locale it already asked the user for.
    """
    scaler = scaler or I18nAutoScaler()
    discovery = scaler.discover_locales(locales_dir)
    root = discovery.root
    locales = sorted(discovery.locales)
    if not locales:
        raise EditorError("no-locales", f"No locales found under {root}.")
    if namespace != FLAT_NAMESPACE and namespace not in _namespaces_of(discovery):
        raise EditorError(
            "no-namespace",
            f"No namespace {namespace!r} under {root}.",
            namespace=namespace,
        )

    flats = {loc: _flat_for(discovery, loc, namespace) for loc in locales}
    keys: set[str] = set()
    for flat in flats.values():
        keys.update(flat)

    reference = reference_locale if reference_locale in flats else locales[0]
    entries: list[Entry] = []
    for key in sorted(keys):
        values: dict[str, str | None] = {
            loc: flats[loc].get(key, None) for loc in locales
        }
        ref_value = values.get(reference)
        mismatch = False
        if ref_value is not None:
            ref_vars = _extract_placeholders(ref_value)
            mismatch = any(
                v is not None and _extract_placeholders(v) != ref_vars
                for loc, v in values.items()
                if loc != reference
            )
        entries.append(Entry(key=key, values=values, placeholder_mismatch=mismatch))

    fingerprints = {
        loc: fingerprint(_read(locale_file(root, loc, namespace))[1]) for loc in locales
    }
    return NamespaceView(
        namespace=namespace,
        locales=locales,
        entries=entries,
        fingerprints=fingerprints,
        root=str(root),
    )


# ----------------------------------------------------------------------
# Writing


def validate_key(key: str) -> str:
    """The key, or a refusal naming what is wrong with it."""
    key = key.strip()
    if not key:
        raise EditorError("key-empty", "A key cannot be empty.")
    if len(key) > MAX_KEY_LEN:
        raise EditorError(
            "key-too-long", f"A key cannot be longer than {MAX_KEY_LEN} characters."
        )
    if not _KEY_RE.match(key):
        raise EditorError(
            "key-shape",
            f"{key!r} is not a usable key.",
            key=key,
        )
    return key


def _validate_value(value: str | None) -> str | None:
    if value is None:
        return None
    if len(value) > MAX_VALUE_LEN:
        raise EditorError(
            "value-too-long",
            f"A value cannot be longer than {MAX_VALUE_LEN} characters.",
        )
    return value


def _check_no_prefix_collision(flat: dict[str, str], key: str, locale: str) -> None:
    """Refuse a key that would have to be both a string and an object.

    ``a.b`` and ``a.b.c`` cannot coexist: `unflatten` would overwrite one with
    the other and the loss would be silent. Catching it here means the caller
    is told which existing key is in the way.
    """
    for existing in flat:
        if existing == key:
            continue
        if existing.startswith(key + "."):
            raise EditorError(
                "key-nests-under",
                f"{key!r} cannot hold a value in {locale}: {existing!r} already "
                "nests underneath it.",
                key=key,
                locale=locale,
                other=existing,
            )
        if key.startswith(existing + "."):
            raise EditorError(
                "key-nested-in",
                f"{key!r} cannot be created in {locale}: {existing!r} already holds "
                "a value at that path.",
                key=key,
                locale=locale,
                other=existing,
            )


@dataclass
class ApplyResult:
    namespace: str
    written: list[str] = field(default_factory=list)
    fingerprints: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "namespace": self.namespace,
            "written": self.written,
            "fingerprints": self.fingerprints,
        }


def apply_operations(
    locales_dir: Path | str,
    namespace: str,
    operations: list[Operation],
    expected_fingerprints: dict[str, str] | None = None,
    scaler: I18nAutoScaler | None = None,
) -> ApplyResult:
    """Apply every operation, or none of them.

    The whole batch is validated and built in memory first, and only then are
    the files replaced. A batch that fails halfway — a bad key in the tenth
    edit — would otherwise leave the namespace half-saved across locales, which
    is worse than not saving: the report would then show a drift nobody made.

    A file whose content did not change is not rewritten, so saving an edit to
    ``fr`` leaves ``en``'s mtime alone and the diff holds one file.
    """
    scaler = scaler or I18nAutoScaler()
    discovery = scaler.discover_locales(locales_dir)
    root = discovery.root
    locales = sorted(discovery.locales)
    if not locales:
        raise EditorError("no-locales", f"No locales found under {root}.")

    # Read every locale's file once: raw text for the style and the
    # fingerprint, parsed content for the edit.
    raws: dict[str, str] = {}
    flats: dict[str, dict[str, str]] = {}
    styles: dict[str, tuple[str | int, bool]] = {}
    for loc in locales:
        path = locale_file(root, loc, namespace)
        data, raw = _read(path)
        raws[loc] = raw
        # The file *is* the section, in both layouts: `<locale>/<ns>.json` holds
        # the namespace's keys at its top level, and `<locale>.json` holds the
        # whole locale's. Reading `data[namespace]` instead looked right and was
        # not — it found nothing, so every edit landed in an empty document and
        # the save appended a second copy of the keys beside the real ones.
        flats[loc] = flatten(data)
        styles[loc] = (detect_indent(raw), raw.endswith("\n") if raw else True)

    if expected_fingerprints:
        for loc, expected in expected_fingerprints.items():
            if loc not in raws:
                continue
            if fingerprint(raws[loc]) != expected:
                raise StaleFileError(
                    f"{locale_file(root, loc, namespace).name} changed on disk.",
                    file=locale_file(root, loc, namespace).name,
                )

    for operation in operations:
        _apply_one(operation, flats)

    written: list[str] = []
    fingerprints: dict[str, str] = {}
    pending: list[tuple[Path, str]] = []
    for loc in locales:
        path = locale_file(root, loc, namespace)
        indent, trailing = styles[loc]
        text = dump_json(unflatten(flats[loc]), indent, trailing)
        fingerprints[loc] = fingerprint(text)
        if text != raws[loc]:
            pending.append((path, text))
            written.append(str(path))

    for path, text in pending:
        _write_atomic(path, text)

    return ApplyResult(namespace=namespace, written=written, fingerprints=fingerprints)


def _apply_one(operation: Operation, flats: dict[str, dict[str, str]]) -> None:
    key = validate_key(operation.key)

    if operation.op == "delete":
        if not any(key in flat for flat in flats.values()):
            raise EditorError("unknown-key", f"{key!r} is not here.", key=key)
        for flat in flats.values():
            flat.pop(key, None)
        return

    if operation.op == "rename":
        new_key = validate_key(operation.new_key or "")
        if new_key == key:
            return
        if not any(key in flat for flat in flats.values()):
            raise EditorError("unknown-key", f"{key!r} is not here.", key=key)
        if any(new_key in flat for flat in flats.values()):
            raise EditorError("key-taken", f"{new_key!r} is taken.", key=new_key)
        for locale, flat in flats.items():
            if key not in flat:
                continue
            moved = flat.pop(key)
            _check_no_prefix_collision(flat, new_key, locale)
            flat[new_key] = moved
        return

    if operation.op == "add" and any(key in flat for flat in flats.values()):
        raise EditorError("key-taken", f"{key!r} is taken.", key=key)

    # `set` and `add` both write the values they were given, and only those:
    # a locale the caller left out keeps whatever it had, so editing the French
    # column never invents an English string.
    for locale, value in operation.values.items():
        if locale not in flats:
            raise EditorError(
                "unknown-locale", f"{locale!r} is not a locale here.", locale=locale
            )
        flat = flats[locale]
        if value is None:
            flat.pop(key, None)
            continue
        _check_no_prefix_collision(flat, key, locale)
        flat[key] = _validate_value(value) or ""


# ----------------------------------------------------------------------
# Finding the locales in a project


#: Directory names that hold translations often enough to be worth opening.
#: Narrow on purpose: the walk below runs on someone's whole checkout, and a
#: loose list turns it into a scan of every JSON file in the project.
_LOCALE_DIR_NAMES = {"locales", "locale", "i18n", "lang", "langs", "translations"}

#: Pruned wholesale. The same names `architecture/import_analyzer.py` skips,
#: for the same reason: a single `node_modules` holds more candidate
#: directories than the project ever will, and none of them are the project's.
_SKIP_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".workpilot",
    "vendor",
    "target",
}

MAX_SCAN_DEPTH = 8
MAX_CANDIDATES = 12


@dataclass
class LocaleRoot:
    """A directory in the project that really does hold translations."""

    path: str
    relative: str
    locales: list[str]
    layout: str
    namespaces: int

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "relative": self.relative,
            "locales": self.locales,
            "layout": self.layout,
            "namespaces": self.namespaces,
        }


def find_locale_roots(
    project_dir: Path | str, scaler: I18nAutoScaler | None = None
) -> list[LocaleRoot]:
    """The translation directories inside a project, best first.

    The editor sits in a panel that already knows which project is open, and
    making someone walk a native folder dialog down to
    ``apps/frontend/src/shared/i18n/locales`` is a worse answer than offering
    it. The picker stays for everything this does not find.

    A candidate is only returned once `discover_locales` has actually read
    locales out of it, so a directory merely *named* ``i18n`` never appears.
    Ordered by how much it holds, because a monorepo has more than one and the
    one with the translations in it is the one wanted.
    """
    scaler = scaler or I18nAutoScaler()
    root = Path(project_dir)
    if not root.is_dir():
        raise EditorError("not-a-directory", f"Not a directory: {root}")

    found: list[LocaleRoot] = []
    seen: set[Path] = set()
    for dirpath, dirnames, _files in os.walk(root):
        here = Path(dirpath)
        depth = len(here.relative_to(root).parts)
        if depth >= MAX_SCAN_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = [
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")
        ]
        for name in list(dirnames):
            if name.lower() not in _LOCALE_DIR_NAMES:
                continue
            candidate = (here / name).resolve()
            if candidate in seen:
                continue
            seen.add(candidate)
            try:
                discovery = scaler.discover_locales(candidate)
            except (OSError, ValueError):
                continue
            if not discovery.locales:
                continue
            # Its own locale subdirectories are not separate candidates.
            if candidate == here.resolve():
                continue
            found.append(
                LocaleRoot(
                    path=str(discovery.root),
                    relative=str(discovery.root.relative_to(root))
                    if discovery.root.is_relative_to(root)
                    else str(discovery.root),
                    locales=sorted(discovery.locales),
                    layout=discovery.layout,
                    namespaces=len(_namespaces_of(discovery)),
                )
            )
            if len(found) >= MAX_CANDIDATES:
                break
        if len(found) >= MAX_CANDIDATES:
            break

    found.sort(key=lambda r: (-len(r.locales), -r.namespaces, r.relative))
    return found

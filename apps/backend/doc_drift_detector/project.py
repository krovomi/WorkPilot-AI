"""One scan of a project's documentation against its code, on every stack (#354).

The runner (the page), ``python -m doc_drift_detector check`` (the CI) and the
QA gate (a task's own changes) share it. It reads:

- the documents (``.md``, ``.mdx``, ``.rst``, ``.adoc``): functions and files
  they cite (`drift_scanner.py`), their code examples (`examples.py`);
- the source files: their doc comments against their declarations
  (`signatures.py`);
- git: documents the code moved past (`staleness.py`).

With ``changed`` (the files of a change set), only the changed documents and
source files are reported, and a changed source file whose documents were left
as they were is reported as "doc not updated".

Nothing is written; paths are relative and POSIX. Symbolic links are not
followed: a document or source file outside the project is never read.
"""

from __future__ import annotations

import os
import re
import time
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

from doc_languages import language_for, symbol_names

from .drift_scanner import DriftScanner
from .examples import (
    OwnCode,
    check_examples,
    ignored_lines,
    own_code_from_manifests,
    python_index,
)
from .signatures import SignatureDrift, signature_drifts
from .staleness import freshness_score, git_history, linked_code, stale_docs

__all__ = ["DOC_EXTENSIONS", "scan_project"]

DOC_EXTENSIONS = {".md", ".mdx", ".rst", ".adoc"}
DEFAULT_IGNORES = {
    "node_modules", ".git", "dist", "build", ".next", ".nuxt", "__pycache__",
    ".venv", "venv", ".workpilot", "out", "coverage", "bin", "obj", "target",
    "vendor", "Pods", ".dart_tool", ".gradle",
}  # fmt: skip
MAX_SOURCE_BYTES = 600_000
MAX_FILES = 40_000
_WORD = re.compile(r"[A-Za-z_]\w*")
_CODE_REF = re.compile(r"`([a-zA-Z_]\w*(?:\.\w+)*)\(")
_FILE_REF = re.compile(r"`([a-zA-Z0-9_/\\.-]+\.\w{1,5})`")
_NAMESPACE = re.compile(r"^\s*(?:namespace|package)\s+([A-Za-z_][\w.]*)", re.M)
_LOCALE = re.compile(r"\.([a-z]{2}(?:[-_][A-Za-z]{2})?)\.(?:md|mdx|rst|adoc)$")
_LOCALE_DIRS = re.compile(r"(?:^|/)(?:docs?|i18n)/([a-z]{2}(?:[-_][A-Za-z]{2})?)/")

_NOT_PROJECT_DOC_DIRS = frozenset(
    {
        "changelog.d", "skills", "templates", "template", "examples", "fixtures",
        "__fixtures__", "testdata", "test-data", "references", "prompts", "audit",
    }
)  # fmt: skip
_NOT_PROJECT_DOC_NAMES = frozenset(
    {"changelog", "history", "changes", "news", "releases", "release-notes", "skill"}
)


def _walk(root: Path) -> list[Path]:
    """Every file under ``root``, generated and dependency folders pruned."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in DEFAULT_IGNORES)
        for name in sorted(filenames):
            path = Path(dirpath) / name
            if not path.is_symlink():
                out.append(path)
        if len(out) >= MAX_FILES:
            break
    return out


def is_not_project_doc(rel: str) -> bool:
    """Documents that do not describe this code base as it is now:
    changelogs and release notes cite files as they were, agent skills,
    templates and examples describe the reader's project."""
    path = PurePosixPath(rel)
    name = path.stem.lower().split(".")[0]
    return name in _NOT_PROJECT_DOC_NAMES or any(
        part.lower() in _NOT_PROJECT_DOC_DIRS for part in path.parts
    )


def _locale(rel: str) -> str:
    m = _LOCALE.search(rel) or _LOCALE_DIRS.search(rel)
    return m.group(1) if m else ""


def file_resolver(root: Path, all_files: set[str]) -> Callable[[str, str], str | None]:
    """How a path cited in a document is found: next to the document, from
    the project root, or as the only project path ending with it (docs often
    cite ``src/x.ts`` from a package README inside a monorepo). Returns the
    project file, ``""`` when the path is fine but is no project file (a local
    ``.env``, another repository's path), None when it is missing."""
    by_tail: dict[str, list[str]] = {}
    for f in all_files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            by_tail.setdefault("/".join(parts[i:]), []).append(f)

    def resolve(doc_path: str, ref: str) -> str | None:
        ref = (ref[2:] if ref.startswith("./") else ref).rstrip("/")
        if ref in all_files:
            return ref
        name = ref.rsplit("/", 1)[-1]
        if name.startswith(".env") or name.endswith(".local"):
            return ""  # local, git-ignored config the reader creates
        doc_dir = PurePosixPath(doc_path).parent
        joined = os.path.normpath(str(doc_dir / ref)).replace("\\", "/")
        if joined in all_files:
            return joined
        if (root / doc_dir / ref).exists() or (root / ref).exists():
            return ""  # a folder, or a file the walk left out
        tails = by_tail.get(ref, [])
        if len(tails) == 1:
            return tails[0]
        if tails:
            return ""
        # A path whose first folder exists nowhere in this project describes
        # another repository (a guide, an agent skill): not this one's drift.
        first = ref.split("/", 1)[0]
        if not ((root / doc_dir / first).exists() or (root / first).exists()):
            return ""
        return None

    return resolve


def _moved_to(ref: str, all_files: set[str]) -> str | None:
    """The one project file with the cited file's name, when it moved."""
    name = ref.rstrip("/").rsplit("/", 1)[-1]
    found = [f for f in all_files if f.rsplit("/", 1)[-1] == name]
    return found[0] if len(found) == 1 else None


def _issue(
    drift_type: str,
    severity: str,
    doc: str,
    line: int,
    symbol: str,
    message: str,
    suggestion: str = "",
    **extra: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "driftType": drift_type,
        "severity": severity,
        "docFile": doc,
        "docLine": line,
        "referencedSymbol": symbol,
        "message": message,
        "suggestion": suggestion,
    }
    out.update({k: v for k, v in extra.items() if v not in (None, "", [], {})})
    return out


def _signature_issues(drift: SignatureDrift) -> list[dict[str, Any]]:
    out = []
    for old, new in drift.renamed:
        out.append(
            _issue(
                "signature_mismatch", "high", drift.path, drift.line, drift.symbol,
                f"The doc comment of '{drift.symbol}' documents '{old}', renamed '{new}' in the code",
                f"Rename '{old}' to '{new}' in the doc comment",
                params={"old": old, "new": new},
                fixId=f"rename:{drift.path}:{drift.line}:{old}:{new}",
            )
        )  # fmt: skip
    if drift.removed:
        names = ", ".join(drift.removed)
        out.append(
            _issue(
                "signature_mismatch", "high", drift.path, drift.line, drift.symbol,
                f"The doc comment of '{drift.symbol}' documents {names}, which the code no longer takes",
                f"Remove {names} from the doc comment",
                params={"removed": names},
            )
        )  # fmt: skip
    for name, documented, annotated in drift.types:
        out.append(
            _issue(
                "type_mismatch", "medium", drift.path, drift.line, drift.symbol,
                f"'{name}' is documented as {documented} but annotated {annotated}",
                f"Write {annotated} in the docstring",
                params={"name": name, "documented": documented, "annotated": annotated},
                fixId=f"retype:{drift.path}:{drift.line}:{name}:{annotated}",
            )
        )  # fmt: skip
    if drift.added:
        names = ", ".join(drift.added)
        out.append(
            _issue(
                "undocumented_param", "low", drift.path, drift.line, drift.symbol,
                f"The doc comment of '{drift.symbol}' does not describe {names}",
                f"Describe {names} in the doc comment",
                params={"added": names},
            )
        )  # fmt: skip
    return out


_EXAMPLE_TYPES = {
    "syntax": ("example_syntax", "medium"),
    "invalid_json": ("example_syntax", "medium"),
    "unknown_module": ("example_import", "high"),
    "unknown_name": ("example_import", "high"),
    "wrong_arguments": ("example_arguments", "high"),
}


def scan_project(
    root: Path,
    *,
    changed: set[str] | None = None,
    use_git: bool = True,
    progress: Callable[[str], None] | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    """The drift report of ``root``, every document or only a change set's."""
    say = progress or (lambda _s: None)
    root = Path(root)
    say("Discovering documentation files...")
    files = _walk(root)
    rel_of = {p: p.relative_to(root).as_posix() for p in files}
    all_files = set(rel_of.values())
    doc_rels = sorted(
        r
        for p, r in rel_of.items()
        if p.suffix.lower() in DOC_EXTENSIONS and not is_not_project_doc(r)
    )
    source_paths = [p for p in files if language_for(p.name) is not None]
    say(f"Indexing source code ({len(doc_rels)} docs found)...")

    texts: dict[str, str] = {}

    def read(rel: str) -> str | None:
        if rel in texts:
            return texts[rel]
        path = root / rel
        try:
            if path.is_symlink() or path.stat().st_size > MAX_SOURCE_BYTES:
                return None
            texts[rel] = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return None
        return texts[rel]

    symbols: set[str] = set()
    symbol_files: dict[str, set[str]] = {}
    code_words: set[str] = set()
    source_files: set[str] = set()
    namespaces: set[str] = set()
    languages: dict[str, int] = {}
    issues: list[dict[str, Any]] = []
    for path in source_paths:
        rel = rel_of[path]
        content = read(rel)
        if content is None:
            continue
        names = symbol_names(content, path.name)
        symbols |= names
        for name in names:
            symbol_files.setdefault(name, set()).add(rel)
        code_words.update(_WORD.findall(content))
        source_files.add(rel)
        namespaces.update(_NAMESPACE.findall(content))
        lang = language_for(path.name)
        if lang is not None:
            languages[lang.label] = languages.get(lang.label, 0) + 1
        if changed is None or rel in changed:
            for drift in signature_drifts(rel, content):
                issues.extend(_signature_issues(drift))

    modules, packages = python_index(source_files)
    manifests = own_code_from_manifests(root, all_files)
    own = OwnCode(
        python_modules=modules,
        python_packages=packages,
        code_words=code_words,
        namespaces=namespaces,
        files=all_files,
        read=read,
        **manifests,  # type: ignore[arg-type]
    )

    say(f"Comparing {len(doc_rels)} docs against {len(symbols)} symbols...")
    resolve = file_resolver(root, all_files)
    scanner = DriftScanner()
    links: dict[str, set[str]] = {}
    for doc in doc_rels:
        content = read(doc)
        if content is None:
            continue
        ignored = ignored_lines(content)
        if ignored is None:
            continue
        cited_files = {
            resolve(doc, m.replace("\\", "/")) for m in _FILE_REF.findall(content)
        }
        cited_symbols = {m.rsplit(".", 1)[-1] for m in _CODE_REF.findall(content)}
        links[doc] = linked_code(
            doc,
            {f for f in cited_files if f},
            cited_symbols,
            symbol_files,
            source_files,
        )
        if changed is not None and doc not in changed:
            continue
        report = scanner.scan(
            {doc: content},
            symbols,
            source_files,
            code_words=code_words,
            file_exists=lambda d, ref: resolve(d, ref) is not None,
        )
        for found in report.issues:
            if found.doc_line in ignored:
                continue
            extra: dict[str, Any] = {}
            if found.drift_type.value == "stale_reference":
                target = _moved_to(found.referenced_symbol, all_files)
                if target:
                    extra = {
                        "params": {"target": target},
                        "fixId": f"path:{doc}:{found.doc_line}:{found.referenced_symbol}:{target}",
                    }
            issues.append(
                _issue(
                    found.drift_type.value, found.severity.value, doc, found.doc_line,
                    found.referenced_symbol, found.message, found.suggestion, **extra,
                )
            )  # fmt: skip
        for example in check_examples(content, own):
            drift_type, severity = _EXAMPLE_TYPES[example.kind]
            issues.append(
                _issue(
                    drift_type, severity, doc, example.line, example.symbol,
                    f"Code example: {example.kind.replace('_', ' ')} {example.symbol} {example.detail}".strip(),
                    params={"kind": example.kind, "detail": example.detail},
                )
            )  # fmt: skip

    moment = int(now if now is not None else time.time())
    history = git_history(root, moment) if use_git else None
    stale = stale_docs(links, history) if changed is None else {}
    for doc, (since, code) in stale.items():
        days = max(0, (moment - since) // 86_400)
        issues.append(
            _issue(
                "stale_doc", "low" if days < 30 else "medium", doc, 1, code[0],
                f"{len(code)} file(s) it describes changed after it, for {days} day(s)",
                "Read the changes and update the document",
                params={"files": ", ".join(code[:5]), "count": len(code), "days": days},
                files=code[:20], since=since,
            )
        )  # fmt: skip
    if changed is not None:
        for doc, code in sorted(links.items()):
            touched = sorted(code & changed)
            if touched and doc not in changed:
                issues.append(
                    _issue(
                        "doc_not_updated", "low", doc, 1, touched[0],
                        f"The change edits {', '.join(touched[:3])} but not this document",
                        "Check whether the document still holds",
                        params={"files": ", ".join(touched[:5]), "count": len(touched)},
                        files=touched[:20],
                    )
                )  # fmt: skip

    per_doc: dict[str, list[dict[str, Any]]] = {}
    for issue in issues:
        per_doc.setdefault(issue["docFile"], []).append(issue)
    freshness = []
    for doc in doc_rels:
        if doc not in links:
            continue
        since = stale.get(doc, (None, []))[0]
        days = (moment - since) // 86_400 if since else None
        own_issues = per_doc.get(doc, [])
        # Staleness costs by its age, not as one more problem.
        severities = [
            i["severity"] for i in own_issues if i["driftType"] != "stale_doc"
        ]
        last = history.last(doc) if history else None
        freshness.append(
            {
                "docFile": doc,
                "score": freshness_score(severities, days),
                "lastUpdated": last,
                "staleSince": since,
                "locale": _locale(doc),
                "issues": len(own_issues),
            }
        )
    freshness.sort(key=lambda f: (f["score"], f["docFile"]))
    average = (
        round(sum(f["score"] for f in freshness) / len(freshness))
        if freshness
        else None
    )

    by_type: dict[str, int] = {}
    for issue in issues:
        by_type[issue["driftType"]] = by_type.get(issue["driftType"], 0) + 1
    return {
        "docsScanned": len(links),
        "codeFilesIndexed": len(source_files),
        "symbolsIndexed": len(symbols),
        "languages": [
            {"label": label, "files": count}
            for label, count in sorted(languages.items(), key=lambda kv: -kv[1])
        ],
        "docFiles": sorted(links),
        "issues": issues,
        "summary": ", ".join(f"{n} {t}" for t, n in by_type.items())
        or "No drift detected",
        "freshness": freshness,
        "averageFreshness": average,
        "fixable": sum(1 for i in issues if i.get("fixId")),
        "git": history is not None,
        "scope": "changes" if changed is not None else "project",
    }

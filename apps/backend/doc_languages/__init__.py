"""Source languages the documentation features understand.

One table for "which files are code, which symbols they declare, which doc
comment sits above each one, and what a new doc comment looks like" in every
stack WorkPilot supports (.NET, Java/Kotlin, Go, Rust, Swift, PHP, Ruby, Dart,
C/C++, JS/TS and the web frameworks). The Documentation agent reads it to
measure coverage and draft doc comments outside Python, and the doc-drift
runner reads it to index the symbols a README may name.

A leaf: the standard library only.
"""

from .polyglot import (
    LANGUAGES,
    Language,
    SourceSymbol,
    doc_comment_template,
    extract_symbols,
    language_for,
    param_names,
    symbol_names,
)

__all__ = [
    "LANGUAGES",
    "Language",
    "SourceSymbol",
    "doc_comment_template",
    "extract_symbols",
    "language_for",
    "param_names",
    "symbol_names",
]

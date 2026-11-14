"""Which files belong to a WinDev, WebDev or WinDev Mobile project, and in which format.

PC SOFT's editors save every element in one of two formats. The native one is
binary: the file starts with ``PCS`` and the rest is compressed, so nothing in
it can be read or written outside the editor. The text one, an option since
version 25 meant for Git ("Format de sauvegarde des éléments" in the project
description), is a YAML file whose first line is the comment in
``TEXT_HEADER``: the WLangage code is plain text in ``code : |1+`` blocks, and
everything the editor draws (positions, captions, bindings) sits in base64
``internal_properties`` blobs only the editor can produce.

Even in a text project, some elements stay binary (observed on public
projects saved by WinDev 25 to 28): the analysis, the queries, the automated
test scenarios, styles and templates, and the HFSQL data files. A reader asks
`file_format` instead of trusting the extension.
"""

from __future__ import annotations

from pathlib import Path

__all__ = [
    "BINARY_ONLY_EXTENSIONS",
    "DATA_EXTENSIONS",
    "ELEMENT_KINDS",
    "NATIVE_MAGIC",
    "TEXT_HEADER",
    "TEXT_CAPABLE_EXTENSIONS",
    "file_format",
    "is_windev_path",
    "sniff_format",
]

#: The first line of every element saved in the text format.
TEXT_HEADER = "#To edit and compare internal_properties, use WINDEV integrated tools."
#: The first bytes of an element saved in the native, binary format.
NATIVE_MAGIC = b"PCS"

#: Extension -> what the element is, for every element a project lists.
ELEMENT_KINDS: dict[str, str] = {
    ".wdp": "project",
    ".wdw": "window",
    ".wdc": "class",
    ".wdg": "procedures",
    ".wde": "report",
    ".wdt": "template",
    ".wwh": "page",
    ".wdr": "query",
    ".wda": "analysis",
    ".wdd": "analysis",
    ".wxt": "test",
}

#: Elements the text format can hold as YAML.
TEXT_CAPABLE_EXTENSIONS = frozenset(
    {".wdp", ".wdw", ".wdc", ".wdg", ".wde", ".wdt", ".wwh"}
)
#: Elements that stay binary in a text project.
BINARY_ONLY_EXTENSIONS = frozenset({".wdr", ".wda", ".wdd", ".wxt"})
#: HFSQL data, index and memo files: data, never source.
DATA_EXTENSIONS = frozenset({".fic", ".ndx", ".mmo"})


def is_windev_path(path: str | Path) -> bool:
    """True for an element of a WinDev project or an HFSQL data file."""
    suffix = Path(str(path)).suffix.lower()
    return suffix in ELEMENT_KINDS or suffix in DATA_EXTENSIONS


def sniff_format(head: bytes) -> str:
    """``"text"``, ``"native"`` or ``"unknown"`` from a file's first bytes."""
    text = head.lstrip(b"\xef\xbb\xbf")
    if text.startswith(TEXT_HEADER.encode("ascii")):
        return "text"
    if text.startswith(NATIVE_MAGIC):
        return "native"
    return "unknown"


def file_format(path: Path) -> str:
    """The format ``path`` is saved in; ``"unknown"`` when it cannot be read."""
    try:
        with open(path, "rb") as handle:
            head = handle.read(len(TEXT_HEADER) + 3)
    except OSError:
        return "unknown"
    return sniff_format(head)

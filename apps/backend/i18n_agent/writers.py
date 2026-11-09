"""Adding keys to a catalog file in its own format, without rewriting the rest (#346).

Only missing keys are added; an existing value is never overwritten. JSON
and ARB keep their key order and indentation; the line formats (Java
``.properties``, iOS ``.strings``) and the XML ones (Android ``strings.xml``,
.NET ``.resx``) get the new entries appended before their closing element,
escaped for the format. YAML (Rails), XLIFF, gettext and PHP catalogs are
not written: their structure (comments, units, plural forms) is not kept by
a simple writer, so the report lists their translations for the person.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

__all__ = ["WRITABLE_FORMATS", "add_entries"]

WRITABLE_FORMATS = frozenset(
    {"json", "arb", "properties", "strings", "android", "resx"}
)


def _indent(text: str) -> str | int:
    match = re.search(r"\n([ \t]+)\"", text)
    if not match:
        return 2
    unit = match.group(1)
    return "\t" if unit.startswith("\t") else len(unit)


def _set_nested(data: dict, key: str, value: str, nested: bool) -> bool:
    if not nested or key in data:
        if key in data:
            return False
        data[key] = value
        return True
    node = data
    parts = key.split(".")
    for part in parts[:-1]:
        child = node.get(part)
        if child is None:
            child = node[part] = {}
        if not isinstance(child, dict):
            return False  # "a" is a string: "a.b" cannot live under it
        node = child
    if parts[-1] in node:
        return False
    node[parts[-1]] = value
    return True


def _json_like(path: Path, entries: dict[str, str], nested: bool) -> list[str]:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text) if text.strip() else {}
    if not isinstance(data, dict):
        return []
    # A file that already writes ``"a.b": "x"`` at the top level stays flat.
    nested = nested and not any(
        "." in k and not isinstance(v, dict) for k, v in data.items()
    )
    added = [
        k for k, v in entries.items() if _set_nested(data, k, v, nested and "." in k)
    ]
    if added:
        out = json.dumps(data, ensure_ascii=False, indent=_indent(text))
        path.write_text(
            out + ("\n" if text.endswith("\n") or not text else ""), encoding="utf-8"
        )
    return added


def _escape_properties(value: str) -> str:
    out = value.replace("\\", "\\\\").replace("\n", "\\n")
    return "".join(c if ord(c) < 0x7F else f"\\u{ord(c):04x}" for c in out)


def _escape_strings(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _escape_xml(value: str, android: bool) -> str:
    out = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if android:
        out = out.replace("'", "\\'").replace('"', '\\"')
        if out[:1] in ("@", "?"):
            out = "\\" + out  # a leading @ or ? reads as a resource reference
    return out


def _append_lines(path: Path, lines: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    joiner = "" if text.endswith("\n") or not text else "\n"
    path.write_text(text + joiner + "\n".join(lines) + "\n", encoding="utf-8")


def _insert_before(path: Path, closing: str, block: str) -> bool:
    text = path.read_text(encoding="utf-8")
    index = text.rfind(closing)
    if index < 0:
        return False
    path.write_text(text[:index] + block + text[index:], encoding="utf-8")
    return True


def add_entries(
    path: Path, fmt: str, entries: dict[str, str], existing: set[str]
) -> list[str]:
    """Add the ``entries`` the file lacks; returns the keys it added."""
    wanted = {k: v for k, v in entries.items() if k not in existing}
    if not wanted or fmt not in WRITABLE_FORMATS or path.is_symlink():
        return []
    if fmt == "json":
        return _json_like(path, wanted, nested=True)
    if fmt == "arb":
        return _json_like(path, wanted, nested=False)
    if fmt == "properties":
        _append_lines(path, [f"{k}={_escape_properties(v)}" for k, v in wanted.items()])
        return list(wanted)
    if fmt == "strings":
        _append_lines(
            path,
            [
                f'"{_escape_strings(k)}" = "{_escape_strings(v)}";'
                for k, v in wanted.items()
            ],
        )
        return list(wanted)
    if fmt == "android":
        valid = [k for k in wanted if re.fullmatch(r"[A-Za-z_]\w*", k)]
        block = "".join(
            f'    <string name="{k}">{_escape_xml(wanted[k], android=True)}</string>\n'
            for k in valid
        )
        return valid if valid and _insert_before(path, "</resources>", block) else []
    if fmt == "resx":
        block = "".join(
            f'  <data name="{_escape_xml(k, android=False)}" xml:space="preserve">\n'
            f"    <value>{_escape_xml(v, android=False)}</value>\n  </data>\n"
            for k, v in wanted.items()
        )
        return list(wanted) if _insert_before(path, "</root>", block) else []
    return []

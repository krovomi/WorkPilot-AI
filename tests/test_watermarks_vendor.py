"""The vendored Layer A table, against what this integration assumes of it.

`test_watermarks_clean.py` proves WorkPilot's wrapper reads its own settings
correctly. It cannot prove the table underneath still behaves the way the
wrapper is built on top of — every assertion there is about our code.

These are the assertions about **upstream**, and they are what a person moving
the pin (`python3 scripts/vendor_watermarks.py --ref …`) will see fail if a new
release changes something this integration leans on:

  - the tree is the one `VENDOR.json` names, and it came with its licence;
  - `text_unicode.py` imports nothing from its siblings, which is what makes
    copying one file out of a large project safe at all;
  - `clean_text` and `inspect_text` still take the keywords passed to them;
  - **no ASCII codepoint is ever touched** — the property `clean.py`'s fast
    path is built on, and the one that would fail silently, on every file, if
    a future version started normalising something in that range;
  - a zero-width space is removed, and the load-bearing joiners are not.

They deliberately do not pin the full decision table. It grows with every
release, and a test that asserts one exotic codepoint's fate is a test that
gets deleted the first time upstream refines it.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core.vendor_manifest import RECEIPT_NAME, tree_digest  # noqa: E402
from watermarks import runtime as wm_runtime  # noqa: E402

VENDORED = wm_runtime.vendored_root()


def _receipt() -> dict:
    return json.loads((VENDORED / RECEIPT_NAME).read_text(encoding="utf-8"))


def test_vendored_tree_is_present_with_its_licence():
    assert (VENDORED / "text_unicode.py").is_file()
    licence = (VENDORED / "LICENSE").read_text(encoding="utf-8")
    assert "MIT" in licence
    assert _receipt()["license"] == "MIT"


def test_tree_matches_its_receipt():
    """A vendored file edited in place leaves the pin intact and the bytes wrong."""
    recorded = _receipt()["tree_sha256"]
    assert tree_digest(VENDORED) == recorded, (
        "vendored tree differs from VENDOR.json — run "
        "`python3 scripts/vendor_watermarks.py --check` to see which file"
    )


def test_cleaner_is_self_contained():
    """One file was copied out of a project of fifty; this is why that is safe.

    Parsed rather than imported: an import would only prove the siblings happen
    to be importable from wherever the test runs, and the claim is stronger
    than that — there are no siblings in the vendored tree at all.
    """
    tree = ast.parse((VENDORED / "text_unicode.py").read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            imported.add(node.module.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level:
            pytest.fail(f"relative import in vendored cleaner: level {node.level}")
    assert imported <= set(sys.stdlib_module_names), (
        f"vendored cleaner grew a non-stdlib dependency: "
        f"{sorted(imported - set(sys.stdlib_module_names))}"
    )


def test_engine_exposes_the_api_this_integration_drives():
    module = wm_runtime.engine()
    assert module is not None
    cleaned, stats = module.clean_text(
        "x",
        nfkc=False,
        aggressive_homoglyphs=False,
        normalize_spaces=False,
        strip_emoji_glue=False,
        strip_bidi=False,
    )
    assert cleaned == "x"
    assert {"removed", "replaced"} <= set(stats)
    report = module.inspect_text("x")
    assert hasattr(report, "suspicious_total")


@pytest.mark.parametrize("codepoint", range(128))
def test_no_ascii_codepoint_is_ever_touched(codepoint):
    """The property `clean.py`'s `str.isascii()` fast path rests on.

    If a future upstream starts normalising something below U+0080, the fast
    path would skip exactly the files that needed the work — silently, and on
    every build. This is the test that refuses to let that land quietly.
    """
    module = wm_runtime.engine()
    assert module is not None
    char = chr(codepoint)
    for normalize_spaces in (False, True):
        cleaned, _stats = module.clean_text(
            char,
            nfkc=False,
            aggressive_homoglyphs=False,
            normalize_spaces=normalize_spaces,
            strip_emoji_glue=False,
            strip_bidi=False,
        )
        assert cleaned == char, f"U+{codepoint:04X} is no longer passed through"


def test_a_zero_width_space_is_removed_and_the_joiners_are_not():
    module = wm_runtime.engine()
    assert module is not None
    options = {
        "nfkc": False,
        "aggressive_homoglyphs": False,
        "normalize_spaces": False,
        "strip_emoji_glue": False,
        "strip_bidi": False,
    }

    cleaned, stats = module.clean_text("const a​ = 1;", **options)
    assert cleaned == "const a = 1;"
    assert stats["removed_count"] == 1

    # A ZWJ between two emoji bases, and one between two Arabic letters, are
    # the text — not a carrier riding in it.
    for load_bearing in ("\U0001f469‍\U0001f4bb", "م‍ن"):
        kept, _ = module.clean_text(load_bearing, **options)
        assert kept == load_bearing

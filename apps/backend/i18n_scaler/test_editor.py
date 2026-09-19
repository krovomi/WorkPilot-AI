"""Tests for the translation editor — the half of the scaler that writes.

These files are committed source. The properties worth pinning are therefore
not only "the value changed" but "nothing else did": the indentation, the
accents, the trailing newline, the files that had no reason to be touched.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from i18n_scaler.editor import (
    FLAT_NAMESPACE,
    EditorError,
    Operation,
    StaleFileError,
    apply_operations,
    detect_indent,
    dump_json,
    find_locale_roots,
    list_namespaces,
    load_namespace,
    validate_key,
)


def write_nested(root: Path, locale: str, namespace: str, data: dict, indent="\t"):
    d = root / locale
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{namespace}.json").write_text(
        json.dumps(data, indent=indent, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def write_flat(root: Path, locale: str, data: dict):
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{locale}.json").write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


@pytest.fixture
def nested(tmp_path: Path) -> Path:
    root = tmp_path / "locales"
    write_nested(
        root,
        "en",
        "common",
        {"buttons": {"save": "Save", "undo": "Undo"}, "greeting": "Hi {{name}}"},
    )
    write_nested(
        root,
        "fr",
        "common",
        {"buttons": {"save": "Enregistrer"}, "greeting": "Salut {{nom}}"},
    )
    return root


# ----------------------------------------------------------------------
# File style


class TestDetectIndent:
    def test_tabs(self):
        assert detect_indent('{\n\t"a": 1\n}\n') == "\t"

    def test_two_spaces(self):
        assert detect_indent('{\n  "a": 1\n}\n') == 2

    def test_four_spaces(self):
        assert detect_indent('{\n    "a": 1\n}\n') == 4

    def test_a_document_with_no_nesting_falls_back(self):
        assert detect_indent("{}\n") == 2

    def test_blank_lines_are_skipped(self):
        assert detect_indent('{\n\n\t"a": 1\n}\n') == "\t"


class TestDumpJson:
    def test_keeps_accents_readable(self):
        # Escaping to \\u00e9 would rewrite every line of every French file.
        text = dump_json({"a": "Éditer"}, "\t", True)
        assert "Éditer" in text
        assert "\\u00c9" not in text

    def test_honours_the_trailing_newline_either_way(self):
        assert dump_json({"a": 1}, 2, True).endswith("}\n")
        assert dump_json({"a": 1}, 2, False).endswith("}")


class TestValidateKey:
    @pytest.mark.parametrize("key", ["a", "a.b", "buttons.save", "a.b.c.d"])
    def test_accepts(self, key: str):
        assert validate_key(key) == key

    @pytest.mark.parametrize("key", ["", "   ", "a..b", ".a", "a.", "a. b"])
    def test_refuses(self, key: str):
        with pytest.raises(EditorError):
            validate_key(key)


# ----------------------------------------------------------------------
# Reading


class TestListNamespaces:
    def test_counts_translated_and_missing_per_locale(self, nested: Path):
        _, summaries = list_namespaces(nested)
        common = next(s for s in summaries if s.namespace == "common")
        assert common.total_keys == 3
        assert common.translated["en"] == 3
        assert common.translated["fr"] == 2
        assert common.missing["fr"] == 1
        assert common.missing["en"] == 0

    def test_reads_a_flat_layout_as_one_namespace(self, tmp_path: Path):
        root = tmp_path / "locales"
        write_flat(root, "en", {"hello": "Hi", "bye": "Bye"})
        write_flat(root, "fr", {"hello": "Salut"})
        _, summaries = list_namespaces(root)
        assert [s.namespace for s in summaries] == [FLAT_NAMESPACE]
        assert summaries[0].missing["fr"] == 1


class TestLoadNamespace:
    def test_returns_one_row_per_key_across_locales(self, nested: Path):
        view = load_namespace(nested, "common", reference_locale="en")
        assert view.locales == ["en", "fr"]
        assert [e.key for e in view.entries] == [
            "buttons.save",
            "buttons.undo",
            "greeting",
        ]

    def test_a_missing_value_is_none_not_empty(self, nested: Path):
        view = load_namespace(nested, "common", reference_locale="en")
        undo = next(e for e in view.entries if e.key == "buttons.undo")
        assert undo.values["fr"] is None
        assert undo.values["en"] == "Undo"

    def test_flags_diverging_interpolation_variables(self, nested: Path):
        view = load_namespace(nested, "common", reference_locale="en")
        greeting = next(e for e in view.entries if e.key == "greeting")
        assert greeting.placeholder_mismatch is True

    def test_refuses_a_namespace_that_is_not_there(self, nested: Path):
        with pytest.raises(EditorError, match="No namespace"):
            load_namespace(nested, "nope")

    def test_carries_a_fingerprint_per_locale(self, nested: Path):
        view = load_namespace(nested, "common")
        assert set(view.fingerprints) == {"en", "fr"}


# ----------------------------------------------------------------------
# Writing


class TestApplyOperations:
    def test_set_changes_one_value_and_nothing_else(self, nested: Path):
        before_en = (nested / "en" / "common.json").read_text(encoding="utf-8")
        view = load_namespace(nested, "common")
        apply_operations(
            nested,
            "common",
            [Operation(op="set", key="buttons.save", values={"fr": "Sauver"})],
            expected_fingerprints=view.fingerprints,
        )
        after = load_namespace(nested, "common")
        save = next(e for e in after.entries if e.key == "buttons.save")
        assert save.values == {"en": "Save", "fr": "Sauver"}
        # A locale the edit did not name keeps its file byte for byte.
        assert (nested / "en" / "common.json").read_text(encoding="utf-8") == before_en

    def test_a_file_that_did_not_change_is_not_rewritten(self, nested: Path):
        view = load_namespace(nested, "common")
        result = apply_operations(
            nested,
            "common",
            [Operation(op="set", key="buttons.save", values={"fr": "Sauver"})],
            expected_fingerprints=view.fingerprints,
        )
        assert [Path(p).parent.name for p in result.written] == ["fr"]

    def test_add_creates_the_key_only_where_a_value_was_given(self, nested: Path):
        apply_operations(
            nested,
            "common",
            [Operation(op="add", key="buttons.redo", values={"en": "Redo"})],
        )
        view = load_namespace(nested, "common")
        redo = next(e for e in view.entries if e.key == "buttons.redo")
        assert redo.values == {"en": "Redo", "fr": None}

    def test_delete_removes_the_key_from_every_locale(self, nested: Path):
        apply_operations(nested, "common", [Operation(op="delete", key="buttons.save")])
        view = load_namespace(nested, "common")
        assert "buttons.save" not in [e.key for e in view.entries]

    def test_rename_moves_the_key_in_every_locale_that_had_it(self, nested: Path):
        apply_operations(
            nested,
            "common",
            [Operation(op="rename", key="buttons.save", new_key="actions.save")],
        )
        view = load_namespace(nested, "common")
        moved = next(e for e in view.entries if e.key == "actions.save")
        assert moved.values == {"en": "Save", "fr": "Enregistrer"}

    def test_an_explicit_null_removes_the_key_from_one_locale_only(self, nested: Path):
        apply_operations(
            nested,
            "common",
            [Operation(op="set", key="buttons.save", values={"fr": None})],
        )
        view = load_namespace(nested, "common")
        save = next(e for e in view.entries if e.key == "buttons.save")
        assert save.values == {"en": "Save", "fr": None}

    def test_keeps_the_file_style(self, nested: Path):
        apply_operations(
            nested,
            "common",
            [
                Operation(
                    op="set", key="greeting", values={"fr": "Salut {{name}} — ça va"}
                )
            ],
        )
        raw = (nested / "fr" / "common.json").read_text(encoding="utf-8")
        assert raw.splitlines()[1].startswith("\t")
        assert raw.endswith("\n")
        assert "ça" in raw and "\\u00e7" not in raw

    def test_edits_a_flat_layout_in_place(self, tmp_path: Path):
        root = tmp_path / "locales"
        write_flat(root, "en", {"hello": "Hi"})
        write_flat(root, "fr", {"hello": "Salut"})
        apply_operations(
            root,
            FLAT_NAMESPACE,
            [Operation(op="set", key="hello", values={"fr": "Bonjour"})],
        )
        assert json.loads((root / "fr.json").read_text(encoding="utf-8")) == {
            "hello": "Bonjour"
        }


class TestRefusals:
    def test_a_stale_fingerprint_stops_the_whole_batch(self, nested: Path):
        view = load_namespace(nested, "common")
        # Somebody else saves first.
        apply_operations(
            nested,
            "common",
            [Operation(op="set", key="buttons.save", values={"fr": "Ailleurs"})],
        )
        before = (nested / "fr" / "common.json").read_text(encoding="utf-8")

        with pytest.raises(StaleFileError):
            apply_operations(
                nested,
                "common",
                [Operation(op="set", key="buttons.save", values={"fr": "Sauver"})],
                expected_fingerprints=view.fingerprints,
            )
        assert (nested / "fr" / "common.json").read_text(encoding="utf-8") == before

    def test_a_bad_operation_leaves_every_file_untouched(self, nested: Path):
        """All or nothing: a half-saved namespace is a drift nobody made."""
        before = {
            loc: (nested / loc / "common.json").read_text(encoding="utf-8")
            for loc in ("en", "fr")
        }
        with pytest.raises(EditorError):
            apply_operations(
                nested,
                "common",
                [
                    Operation(op="set", key="buttons.save", values={"fr": "Sauver"}),
                    Operation(op="add", key="a..b", values={"en": "boom"}),
                ],
            )
        for loc, raw in before.items():
            assert (nested / loc / "common.json").read_text(encoding="utf-8") == raw

    def test_refuses_a_key_that_would_have_to_be_a_string_and_an_object(
        self, nested: Path
    ):
        with pytest.raises(EditorError, match="already holds a value"):
            apply_operations(
                nested,
                "common",
                [Operation(op="add", key="buttons.save.deep", values={"en": "x"})],
            )

    def test_refuses_to_add_a_key_that_exists(self, nested: Path):
        with pytest.raises(EditorError, match="already exists"):
            apply_operations(
                nested,
                "common",
                [Operation(op="add", key="buttons.save", values={"en": "x"})],
            )

    def test_refuses_to_rename_onto_an_existing_key(self, nested: Path):
        with pytest.raises(EditorError, match="already exists"):
            apply_operations(
                nested,
                "common",
                [Operation(op="rename", key="buttons.save", new_key="buttons.undo")],
            )

    def test_refuses_a_locale_it_does_not_have(self, nested: Path):
        with pytest.raises(EditorError, match="not one of the locales"):
            apply_operations(
                nested,
                "common",
                [Operation(op="set", key="buttons.save", values={"de": "Speichern"})],
            )

    def test_reports_a_broken_json_file_by_name(self, tmp_path: Path):
        root = tmp_path / "locales"
        write_nested(root, "en", "common", {"a": "b"})
        (root / "fr").mkdir(parents=True, exist_ok=True)
        (root / "fr" / "common.json").write_text("{ not json", encoding="utf-8")
        with pytest.raises(EditorError, match="common.json is not valid JSON"):
            apply_operations(
                root, "common", [Operation(op="set", key="a", values={"en": "c"})]
            )


# ----------------------------------------------------------------------
# Finding the locales in a project


class TestFindLocaleRoots:
    def test_finds_a_nested_locales_directory(self, tmp_path: Path):
        project = tmp_path / "proj"
        root = project / "apps" / "frontend" / "src" / "i18n" / "locales"
        write_nested(root, "en", "common", {"a": "A"})
        write_nested(root, "fr", "common", {"a": "A"})
        found = find_locale_roots(project)
        assert [Path(r.relative).as_posix() for r in found] == [
            "apps/frontend/src/i18n/locales"
        ]
        assert found[0].locales == ["en", "fr"]
        assert found[0].namespaces == 1

    def test_ignores_a_directory_that_is_only_named_like_one(self, tmp_path: Path):
        """`i18n/` full of source files is not a translation directory."""
        project = tmp_path / "proj"
        (project / "src" / "i18n").mkdir(parents=True)
        (project / "src" / "i18n" / "index.ts").write_text(
            "export {}", encoding="utf-8"
        )
        assert find_locale_roots(project) == []

    def test_skips_dependencies(self, tmp_path: Path):
        """One node_modules holds more candidates than the project ever will."""
        project = tmp_path / "proj"
        buried = project / "node_modules" / "pkg" / "locales"
        write_nested(buried, "en", "common", {"a": "A"})
        assert find_locale_roots(project) == []

    def test_orders_the_richest_first(self, tmp_path: Path):
        project = tmp_path / "proj"
        small = project / "a" / "locales"
        write_nested(small, "en", "one", {"a": "A"})
        write_nested(small, "fr", "one", {"a": "A"})
        big = project / "b" / "locales"
        for ns in ("one", "two", "three"):
            write_nested(big, "en", ns, {"a": "A"})
            write_nested(big, "fr", ns, {"a": "A"})
        assert [r.namespaces for r in find_locale_roots(project)] == [3, 1]

    def test_finds_a_flat_layout_too(self, tmp_path: Path):
        project = tmp_path / "proj"
        write_flat(project / "locales", "en", {"a": "A"})
        write_flat(project / "locales", "fr", {"a": "A"})
        found = find_locale_roots(project)
        assert len(found) == 1
        assert found[0].layout == "flat"

    def test_refuses_a_path_that_is_not_a_directory(self, tmp_path: Path):
        with pytest.raises(EditorError, match="Not a directory"):
            find_locale_roots(tmp_path / "missing")

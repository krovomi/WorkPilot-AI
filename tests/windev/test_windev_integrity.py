"""The WinDev integrity check: only what an agent can write may change.

docs/architecture/windev.md. Every rule here is a fact read in the two
versions of a file; a change that only touches WLangage code passes, and the
check stays silent on files outside WinDev.
"""

from __future__ import annotations

from windev.integrity import FileChange, check_change, check_changes

from tests.windev.samples import NATIVE, PROCEDURE, WINDOW, procedure_set


def _change(path: str, before: str | bytes | None, after: str | bytes | None):
    def enc(value):
        return value.encode("utf-8") if isinstance(value, str) else value

    return FileChange(path, enc(before), enc(after))


def _rules(change: FileChange) -> list[str]:
    return [p.rule for p in check_change(change)]


def test_a_code_only_edit_passes_and_counts_its_lines():
    after = procedure_set().replace(
        "RENVOYER nMontant * 0.1", "RENVOYER nMontant * 0.15"
    )
    report = check_changes([_change("COL_Clients.wdg", procedure_set(), after)])
    assert report.ok
    assert report.checked == ["COL_Clients.wdg"]
    assert report.code_lines_changed == 2  # one line out, one line in


def test_a_procedure_added_like_its_siblings_passes():
    extra = PROCEDURE.format(
        name="Total",
        pid="2193899737526465977",
        body="      PROCEDURE Total() : entier\n      RENVOYER 0\n",
    )
    after = procedure_set(
        procedures=PROCEDURE.format(
            name="CalculeRemise",
            pid="2193899737526465975",
            body="      PROCEDURE CalculeRemise()\n",
        )
        + extra
    )
    before = procedure_set(
        procedures=PROCEDURE.format(
            name="CalculeRemise",
            pid="2193899737526465975",
            body="      PROCEDURE CalculeRemise()\n",
        )
    )
    assert _rules(_change("COL_Clients.wdg", before, after)) == []


def test_a_window_event_edit_passes():
    after = WINDOW.replace(
        "         Ferme()\n",
        "         SI HErreur() ALORS Erreur(HErreurInfo())\n         Ferme()\n",
    )
    assert _rules(_change("FEN_Clients.wdw", WINDOW, after)) == []


def test_any_change_to_a_binary_file_is_refused():
    assert _rules(_change("FEN_Old.wdw", NATIVE, NATIVE + b"\x00")) == [
        "binary-element"
    ]
    assert _rules(_change("Gestion.ana/Gestion.wda", NATIVE, None)) == [
        "binary-element"
    ]
    assert _rules(_change("REQ_Clients.wdr", None, b"SELECT 1")) == ["binary-element"]
    assert _rules(_change("Data/Client.fic", b"a", b"b")) == ["binary-element"]


def test_a_text_element_cannot_be_created_or_deleted_outside_the_editor():
    assert _rules(_change("COL_New.wdg", None, procedure_set("COL_New"))) == [
        "element-created"
    ]
    assert _rules(_change("COL_Clients.wdg", procedure_set(), None)) == [
        "element-deleted"
    ]


def test_an_invented_or_dropped_property_blob_is_refused():
    changed = WINDOW.replace("BgAAAAYAAACwzbWS7TqtmQ22ck", "BgAAAAYAAACwzbWS7TqtmQ22XX")
    assert sorted(_rules(_change("FEN_Clients.wdw", WINDOW, changed))) == [
        "internal_properties-removed",
        "internal_properties-written",
    ]
    no_field = WINDOW.replace(
        "  -\n"
        "    name : SAI_Nom\n"
        "    identifier : 0x24f4cd010a153aee\n"
        "    internal_properties : BgAAAAYAAACwzbWS7TqtmQ22cl\n"
        "    type : 2\n",
        "",
    )
    assert sorted(_rules(_change("FEN_Clients.wdw", WINDOW, no_field))) == [
        "identifier-removed",
        "internal_properties-removed",
    ]


def test_a_control_copied_with_its_identifier_is_refused():
    duplicate = WINDOW.replace(
        "    name : SAI_Nom\n",
        "    name : SAI_Prenom\n"
        "    identifier : 0x24f4cd010a15ffff\n"
        "    type : 2\n"
        "  -\n"
        "    name : SAI_Nom\n",
    )
    assert _rules(_change("FEN_Clients.wdw", WINDOW, duplicate)) == [
        "identifier-written"
    ]


def test_procedure_ids_must_stay_unique_numbers():
    twice = procedure_set().replace("2193899737526465976", "2193899737526465975")
    assert _rules(_change("COL_Clients.wdg", procedure_set(), twice)) == [
        "procedure_id"
    ]
    word = procedure_set().replace("2193899737526465976", "new-id")
    assert _rules(_change("COL_Clients.wdg", procedure_set(), word)) == ["procedure_id"]


def test_a_block_indented_out_of_its_key_breaks_the_file():
    broken = procedure_set().replace(
        "      RENVOYER nMontant * 0.1\n", "RENVOYER nMontant * 0.1\n"
    )
    assert "yaml" in _rules(_change("COL_Clients.wdg", procedure_set(), broken))


def test_a_file_the_editor_wrote_as_invalid_yaml_is_not_judged_on_yaml():
    quirky = procedure_set().replace(
        "  procedure_templates : []\n", "  procedure_templates : []   -\n"
    )
    after = quirky.replace("RENVOYER nMontant * 0.1", "RENVOYER nMontant * 0.2")
    assert _rules(_change("COL_Clients.wdg", quirky, after)) == []


def test_the_header_and_the_info_block_are_the_editors():
    no_header = procedure_set().split("\n", 1)[1]
    assert "header" in _rules(_change("COL_Clients.wdg", procedure_set(), no_header))
    renamed = procedure_set().replace(" name : COL_Clients\n", " name : COL_Autre\n")
    assert _rules(_change("COL_Clients.wdg", procedure_set(), renamed)) == ["info"]


def test_files_outside_windev_are_not_checked():
    report = check_changes(
        [_change("README.md", "a", "b"), _change("src/app.py", None, "x = 1")]
    )
    assert report.ok
    assert report.checked == []
    assert _rules(_change("COL_Clients.wdg", procedure_set(), procedure_set())) == []

"""Reading WinDev elements: which format a file is in, and where its code is.

docs/architecture/windev.md. The reader works line by line because the editor
itself writes YAML a parser refuses; these tests hold the blocks, their owners
and the opaque values it reports.
"""

from __future__ import annotations

from pathlib import Path

from windev.files import file_format, is_windev_path, sniff_format
from windev.text_format import parse_text_element

from tests.windev.samples import NATIVE, WINDOW, procedure_set


def test_the_header_line_tells_the_text_format_from_the_native_one(tmp_path: Path):
    assert sniff_format(procedure_set().encode("utf-8")[:96]) == "text"
    assert (
        sniff_format(b"\xef\xbb\xbf" + procedure_set().encode("utf-8")[:96]) == "text"
    )
    assert sniff_format(NATIVE) == "native"
    assert sniff_format(b"info :\n name : X\n") == "unknown"
    path = tmp_path / "FEN_X.wdw"
    path.write_bytes(NATIVE)
    assert file_format(path) == "native"
    assert file_format(tmp_path / "missing.wdw") == "unknown"


def test_windev_paths_are_elements_and_hfsql_data_only():
    assert is_windev_path("src/FEN_Clients.WDW")
    assert is_windev_path("Gestion.ana/Gestion.wda")
    assert is_windev_path("Data/Client.fic")
    assert not is_windev_path("README.md")
    assert not is_windev_path("styles.sty")


def test_each_procedure_block_is_read_with_its_name_type_and_lines():
    element = parse_text_element(procedure_set())
    assert element.header_ok
    assert (element.name, element.major_version, element.element_type) == (
        "COL_Clients",
        27,
        "7",
    )
    owners = [(b.owner, b.event_type, b.header) for b in element.blocks]
    assert owners == [
        ("CalculeRemise", "458752", "|1-"),
        ("Arrondi", "458752", "|1-"),
    ]
    first = element.blocks[0]
    assert first.code.splitlines()[0] == (
        "PROCEDURE CalculeRemise(nMontant est un monétaire) : monétaire"
    )
    assert first.lines == 3
    assert element.code_lines == 5
    assert sorted(element.opaque["procedure_id"]) == [
        "2193899737526465975",
        "2193899737526465976",
    ]


def test_a_control_event_belongs_to_its_control_and_tabs_stay_code():
    element = parse_text_element(WINDOW)
    owners = [(b.owner, b.event_type) for b in element.blocks]
    assert owners == [
        ("BTN_Valider", "18"),
        ("FEN_Clients", ""),
        ("FEN_Clients", "34"),
        ("Enregistre", "458752"),
    ]
    button = element.blocks[0]
    # The trailing blank line of a `|1+` block is not code.
    assert button.code == "Enregistre()\nFerme()"
    init = element.blocks[2]
    assert "\tInitialise()" in init.code.splitlines()
    assert element.opaque["identifier"]["0x24f4cd010a153aed"] == 1
    assert sum(element.opaque["internal_properties"].values()) == 4


def test_a_line_the_editor_writes_but_yaml_refuses_does_not_stop_the_reader():
    quirky = procedure_set().replace(
        "  procedure_templates : []\n", "  procedure_templates : []   -\n"
    )
    element = parse_text_element(quirky)
    assert [b.owner for b in element.blocks] == ["CalculeRemise", "Arrondi"]


def test_a_file_without_the_header_is_not_text_format():
    element = parse_text_element("info :\n name : X\n")
    assert not element.header_ok
    assert element.blocks == []

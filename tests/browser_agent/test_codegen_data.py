"""The values typed while recording become the generated test's data (#387).

Each one gets a key from its field and a kind by rules; the test reads it by
that key, from a JSON file next to it, a Cypress fixture, or a block of
constants (Java, C#). A secret never becomes data.
"""

from __future__ import annotations

import ast
import json

import pytest
from browser_agent.codegen import FORMATS, export_recording
from browser_agent.codegen_data import (
    classify,
    constant_name,
    data_path,
    extract,
    field_text,
    pascal_name,
)
from browser_agent.recording import RecordedStep, Recording, Selector


def _fill(step_id: str, selector: Selector, value: str = "", **kw) -> RecordedStep:
    return RecordedStep(step_id, "fill", [selector], value=value, **kw)


@pytest.mark.parametrize(
    ("value", "words", "kind"),
    [
        ("ada@x.io", [], "email"),
        ("https://x.io/a", [], "url"),
        ("2026-11-22", [], "date"),
        ("2026-11-22T10:30", [], "date"),
        ("22/11/2026", [], "date"),
        ("+33 6 12 34 56 78", [], "phone"),
        ("06 12 34 56 78", ["phone"], "phone"),
        ("0612", ["phone"], "phone"),
        ("42", [], "number"),
        ("-3,5", [], "number"),
        ("Ada", ["first", "name"], "name"),
        ("ada", ["e", "mail"], "email"),
        ("tomorrow", ["birth", "date"], "date"),
        ("x.io", ["website"], "url"),
        ("a dozen", ["quantity"], "number"),
        ("shoes", ["search"], "text"),
    ],
)
def test_the_kind_comes_from_the_shape_then_the_field(
    value: str, words: list[str], kind: str
) -> None:
    assert classify(value, words) == kind


def test_the_field_is_named_by_its_most_readable_selector() -> None:
    def step(*selectors: Selector) -> RecordedStep:
        return RecordedStep("s1", "fill", list(selectors))

    assert field_text(step(Selector("css", "#a"), Selector("label", "Mail"))) == "Mail"
    assert field_text(step(Selector("placeholder", "Ville"))) == "Ville"
    assert field_text(step(Selector("role", "Search", "searchbox"))) == "Search"
    assert (
        field_text(step(Selector("css", 'form > input[name="zipCode"]'))) == "zipCode"
    )
    assert field_text(step(Selector("css", "#birth-date"))) == "birth-date"
    assert field_text(step(Selector("css", "div > input:nth-of-type(2)"))) == ""


def test_keys_are_ascii_words_unique_and_shared_by_a_repeat() -> None:
    data = extract(
        [
            _fill("s1", Selector("label", "Work e-mail"), "ada@x.io"),
            _fill("s2", Selector("label", "Prénom"), "Ada"),
            _fill("s3", Selector("css", '[name="firstName"]'), "Ada"),
            _fill("s4", Selector("css", "div > input"), "ada@y.io"),
            _fill("s5", Selector("css", "div > input"), "hello"),
            _fill("s6", Selector("css", "div > input"), "hello"),
            _fill("s7", Selector("label", "Work e-mail"), "ada@x.io"),
            _fill("s8", Selector("label", "Work e-mail"), "bob@x.io"),
            _fill("s9", Selector("label", "2nd line"), "Flat 3"),
            _fill("s10", Selector("label", "Test data"), "x"),
            _fill("s11", Selector("label", "x 1a"), "a"),
            _fill("s12", Selector("label", "x1a"), "b"),
        ]
    )
    assert [(v.key, v.kind) for v in data.values] == [
        ("work_e_mail", "email"),
        ("prenom", "name"),
        ("first_name", "name"),
        ("email", "email"),
        ("value", "text"),
        ("work_e_mail_2", "email"),
        ("value_2nd_line", "text"),
        ("test_data_value", "text"),
        ("x_1a", "text"),
        ("x1a_2", "text"),
    ]
    assert data.keys["s6"] == "value" and data.keys["s7"] == "work_e_mail"
    assert data.values[0].to_dict() == {"name": "work_e_mail", "kind": "email"}
    assert constant_name("birth_date") == "BIRTH_DATE"
    assert pascal_name("birth_date") == "BirthDate"


def test_a_secret_or_an_empty_value_is_never_data() -> None:
    field = Selector("label", "Password")
    data = extract(
        [
            _fill("s1", field, secret_env="E2E_PASSWORD"),
            _fill("s2", Selector("label", "Name")),
            RecordedStep("s3", "select", [field], value="fr"),
            RecordedStep("s4", "click", [field]),
        ]
    )
    assert not data and data.keys == {}


@pytest.mark.parametrize("fmt", FORMATS)
def test_every_format_reads_its_typed_values_and_keeps_secrets_in_the_env(
    fmt: str,
) -> None:
    recording = Recording(
        steps=[
            RecordedStep("s1", "navigate", url="http://localhost:3000/signup"),
            _fill("s2", Selector("css", "#email"), "ada@x.io"),
            _fill("s3", Selector("css", "#pw"), secret_env="E2E_PW"),
            _fill("s4", Selector("css", "#birth"), "1990-01-02"),
        ]
    )
    test = export_recording(recording, fmt, "Sign up")
    assert "ada@x.io" not in test.code or fmt in ("selenium-java", "selenium-csharp")
    assert test.env_vars == ["E2E_PW"]
    out = test.to_dict()
    assert out["dataValues"] == [
        {"name": "email", "kind": "email"},
        {"name": "birth", "kind": "date"},
    ]
    if fmt in ("selenium-java", "selenium-csharp"):
        assert "fixture" not in out and "TestData." in test.code
        return
    assert out["fixture"] == {"path": test.data_path, "code": test.data_code}
    assert json.loads(test.data_code or "") == {
        "email": "ada@x.io",
        "birth": "1990-01-02",
    }
    assert "E2E_PW" not in (test.data_code or "")
    folder = test.path.rsplit("/", 1)[0]
    if fmt == "cypress":
        assert test.data_path == "cypress/fixtures/recorded/sign-up.json"
        assert 'cy.fixture("recorded/sign-up.json")' in test.code
    else:
        assert test.data_path == f"{folder}/sign-up.data.json"
        assert '"sign-up.data.json"' in test.code
    if fmt.endswith("python"):
        ast.parse(test.code)


def test_without_typed_values_there_is_no_data() -> None:
    recording = Recording(steps=[RecordedStep("s1", "click", [Selector("css", "#go")])])
    for fmt in FORMATS:
        test = export_recording(recording, fmt)
        out = test.to_dict()
        assert out["dataValues"] == [] and "fixture" not in out
        assert "TEST_DATA" not in test.code and "TestData" not in test.code
        assert "readFileSync" not in test.code and "cy.fixture" not in test.code
    assert data_path("selenium-java", "x", "src/test/java/e2e/XTest.java") is None

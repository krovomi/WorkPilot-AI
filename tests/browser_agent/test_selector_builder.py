"""Selectors are ranked like the Playwright guide; secrets are recognised."""

from __future__ import annotations

from browser_agent.recording import Selector
from browser_agent.selector_builder import (
    build_selectors,
    is_secret_field,
    looks_generated,
    secret_env_name,
)


def test_the_test_id_comes_first_then_role_label_placeholder_text_css() -> None:
    target = {
        "tag": "button",
        "testId": "save",
        "testIdUnique": True,
        "role": "button",
        "name": "Save",
        "label": "Save changes",
        "placeholder": "n/a",
        "text": "Save",
        "id": "save-button",
        "idUnique": True,
        "nameAttr": "save",
        "nameUnique": True,
        "path": "form > button",
    }
    assert build_selectors(target) == [
        Selector("testid", "save"),
        Selector("role", "Save", "button"),
        Selector("label", "Save changes"),
        Selector("placeholder", "n/a"),
        Selector("text", "Save"),
        Selector("css", "#save-button"),
    ]


def test_a_non_unique_or_unknown_candidate_is_left_out() -> None:
    target = {
        "tag": "input",
        "testId": "field",
        "testIdUnique": False,
        "role": "made-up",
        "name": "Email",
        "label": "Email",
        "text": "typed text",
        "id": "email",
        "idUnique": False,
        "nameAttr": 'em"ail',
        "nameUnique": True,
        "path": "",
    }
    assert build_selectors(target) == [
        Selector("label", "Email"),
        Selector("css", 'input[name="em\\"ail"]'),
    ]


def test_another_test_attribute_is_a_css_selector() -> None:
    cy = {"testAttr": {"name": "data-cy", "value": 'go"', "unique": True}}
    assert build_selectors(cy) == [Selector("css", '[data-cy="go\\""]')]
    other = {"testAttr": {"name": "onclick", "value": "x", "unique": True}}
    assert build_selectors(other) == []
    assert build_selectors({"testAttr": {"unique": False}}) == []


def test_long_text_and_long_css_are_not_selectors() -> None:
    target = {"tag": "p", "text": "word " * 30, "path": "div " * 100}
    assert build_selectors(target) == []
    same = {"tag": "input", "id": "email", "idUnique": True, "path": "#email"}
    assert build_selectors(same) == [Selector("css", "#email")]
    dup = {"tag": "a", "text": "Home", "label": "Home"}
    assert build_selectors(dup) == [Selector("label", "Home"), Selector("text", "Home")]


def test_a_generated_id_is_never_used() -> None:
    for element_id in ("btn-a1b2c3", ":r1:", "ember123", "x9f8e7d6c5", "a b"):
        assert looks_generated(element_id), element_id
    for element_id in ("email", "save-button", "main_nav"):
        assert not looks_generated(element_id), element_id
    target = {"tag": "div", "id": "btn-a1b2c3", "idUnique": True, "nameAttr": "q"}
    assert build_selectors(target) == []
    odd_tag = {"tag": "my-el", "nameAttr": "q", "nameUnique": True}
    assert build_selectors(odd_tag) == []


def test_secret_fields_are_recognised() -> None:
    assert is_secret_field({"secret": True})
    assert is_secret_field({"type": "PASSWORD"})
    assert is_secret_field({"autocomplete": "one-time-code"})
    assert is_secret_field({"nameAttr": "user_password"})
    assert is_secret_field({"label": "API key"})
    assert is_secret_field({"id": "otp"})
    assert is_secret_field({"placeholder": "Mot de passe"})
    assert is_secret_field({}, "ghp_" + "a" * 36)
    assert not is_secret_field({"nameAttr": "email", "label": "Email"}, "ada@x.io")
    assert not is_secret_field({"nameAttr": "passenger"})


def test_the_env_name_is_built_from_the_field() -> None:
    assert secret_env_name({"nameAttr": "user-password"}) == "E2E_USER_PASSWORD"
    assert secret_env_name({"nameAttr": "1", "id": "pin"}) == "E2E_PIN"
    assert secret_env_name({"label": "Mot de passe ; rm -rf /"}) == (
        "E2E_MOT_DE_PASSE_RM_RF"
    )
    assert secret_env_name({"placeholder": "é"}) == "E2E_SECRET"
    assert len(secret_env_name({"nameAttr": "x" * 200})) == 64

"""The generated onboarding package must be translatable, end to end.

The page was fully keyed on the component side and still rendered English: the
content itself is written in Python, and it went out as prose. These tests hold
the three sides together — the Python catalogue, `en/onboardingAgent.json` and
`fr/onboardingAgent.json` — and check that nothing generated escapes without a
descriptor.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_BACKEND = _ROOT / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from onboarding_agent import OnboardingPackageBuilder  # noqa: E402
from onboarding_agent.messages import CATALOGUE, Text, text  # noqa: E402

_LOCALES = _ROOT / "apps" / "frontend" / "src" / "shared" / "i18n" / "locales"
_PREFIX = "generated."


def _flatten(node: Any, prefix: str = "") -> dict[str, str]:
    flat: dict[str, str] = {}
    for key, value in node.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            flat.update(_flatten(value, f"{path}."))
        else:
            flat[path] = value
    return flat


def _locale(language: str) -> dict[str, str]:
    payload = json.loads(
        (_LOCALES / language / "onboardingAgent.json").read_text(encoding="utf-8")
    )
    return _flatten(payload.get("generated", {}))


def _placeholders(template: str) -> set[str]:
    return set(re.findall(r"\{\{(\w+)\}\}", template))


@pytest.fixture(scope="module")
def english() -> dict[str, str]:
    return _locale("en")


@pytest.fixture(scope="module")
def french() -> dict[str, str]:
    return _locale("fr")


def test_every_catalogue_key_is_translated(
    english: dict[str, str], french: dict[str, str]
) -> None:
    assert set(CATALOGUE) - set(english) == set(), "missing English keys"
    assert set(CATALOGUE) - set(french) == set(), "missing French keys"


def test_no_locale_key_outlives_its_catalogue_entry(
    english: dict[str, str], french: dict[str, str]
) -> None:
    assert set(english) - set(CATALOGUE) == set()
    assert set(french) - set(CATALOGUE) == set()


def test_english_locale_mirrors_the_python_catalogue(english: dict[str, str]) -> None:
    """The English side has one author: the catalogue the generators use."""
    for key, template in CATALOGUE.items():
        expected = re.sub(r"\{(\w+)\}", r"{{\1}}", template)
        assert english[key] == expected, key


def test_translations_keep_every_placeholder(
    english: dict[str, str], french: dict[str, str]
) -> None:
    """A dropped `{{path}}` turns a sentence into a riddle."""
    for key, value in english.items():
        assert _placeholders(french[key]) == _placeholders(value), key


# ---------------------------------------------------------------------------
# The package itself
# ---------------------------------------------------------------------------


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.fixture(scope="module")
def package(tmp_path_factory: pytest.TempPathFactory) -> Any:
    root = tmp_path_factory.mktemp("repo") / "Shop"
    _write(root / "README.md", "# Shop\n")
    _write(root / ".editorconfig", "root = true\n")
    _write(root / "Shop.sln", "Solution\n")
    _write(
        root / "src" / "Shop.Api" / "Shop.Api.csproj",
        '<Project Sdk="Microsoft.NET.Sdk.Web">'
        "<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>"
        "</Project>",
    )
    _write(root / "src" / "Shop.Api" / "Program.cs", "app.Run();\n")
    for index in range(1, 4):
        _write(
            root / "src" / "Shop.Domain" / f"Order{index}.cs",
            f"public record Order{index}\n{{\n" + "    // field\n" * 90 + "}\n",
        )
        _write(
            root / "src" / "Shop.Application" / f"Handler{index}.cs",
            "public class Handler\n{\n    // TODO: validate the basket\n"
            + "    // step\n" * 90
            + "}\n",
        )
        _write(root / "tests" / "Shop.Tests" / f"Order{index}Tests.cs", "class T {}\n")
    return OnboardingPackageBuilder().build(root).to_dict()


def _descriptors(node: Any) -> list[dict[str, Any]]:
    """Every descriptor in the payload, however deeply nested."""
    found: list[dict[str, Any]] = []
    if isinstance(node, dict):
        if "key" in node and "fallback" in node:
            found.append(node)
            for value in (node.get("params") or {}).values():
                found.extend(_descriptors(value))
            return found
        for value in node.values():
            found.extend(_descriptors(value))
    elif isinstance(node, list):
        for item in node:
            found.extend(_descriptors(item))
    return found


def test_every_descriptor_points_at_a_real_key(package: dict[str, Any]) -> None:
    for descriptor in _descriptors(package):
        if not descriptor["key"]:
            continue  # a raw value: a path, a command, a tool name
        assert descriptor["key"].startswith(_PREFIX)
        assert descriptor["key"][len(_PREFIX) :] in CATALOGUE, descriptor["key"]


def test_every_descriptor_supplies_its_placeholders(
    package: dict[str, Any], english: dict[str, str]
) -> None:
    for descriptor in _descriptors(package):
        if not descriptor["key"]:
            continue
        key = descriptor["key"][len(_PREFIX) :]
        assert _placeholders(english[key]) <= set(descriptor["params"]), key


def test_generated_prose_always_carries_a_descriptor(package: dict[str, Any]) -> None:
    guide = package["guide"]

    for kf in [*guide["key_files"], *guide["entry_points"]]:
        assert kf["reason_i18n"], kf["path"]
    for convention in guide["conventions"]:
        assert convention["name_i18n"] and convention["description_i18n"]
    for command in guide["commands"]:
        assert command["label_i18n"], command["command"]
    for node in guide["architecture"]:
        assert node["role_i18n"], node["path"]
    for lines in guide["section_lines"].values():
        assert all(line["fallback"] for line in lines)

    for step in package["tour"]:
        assert step["reason_i18n"], step["file_path"]
        assert len(step["suggested_questions_i18n"]) == len(step["suggested_questions"])

    for question in package["quiz"]:
        assert question["question_i18n"]
        assert len(question["choices_i18n"]) == len(question["choices"])
        if question["rationale"]:
            assert question["rationale_i18n"]

    for task in package["first_tasks"]:
        assert task["title_i18n"] and task["why_i18n"], task["title"]
        # A TODO's source line is the team's own code — never translated.
        if task["category"] == "todo":
            assert task["source_comment_i18n"] is None
        else:
            assert task["source_comment_i18n"]

    for term in package["glossary"]:
        assert term["definition_i18n"], term["term"]


def test_choice_descriptors_line_up_with_their_choices(
    package: dict[str, Any],
) -> None:
    """The right answer must not be the one written in a different language."""
    for question in package["quiz"]:
        for choice, descriptor in zip(
            question["choices"], question["choices_i18n"], strict=True
        ):
            assert descriptor["fallback"] == choice


def test_fallbacks_match_the_plain_fields(package: dict[str, Any]) -> None:
    for node in package["guide"]["architecture"]:
        assert node["role_i18n"]["fallback"] == node["role"]
    for question in package["quiz"]:
        assert question["question_i18n"]["fallback"] == question["question"]


def test_nested_parameters_render_through(package: dict[str, Any]) -> None:
    """A question quoting a role renders that role, not a placeholder."""
    message = text(
        "quiz.directoryHolds.rationale", path="src", role=text("role.src"), count=3
    )
    assert message.fallback == "`src/` — Application source (3 files)"
    assert isinstance(message.params["role"], Text)


def test_an_unknown_key_is_refused_at_the_source() -> None:
    with pytest.raises(KeyError):
        text("role.doesNotExist")

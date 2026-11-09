"""Translating missing keys and writing them in each catalog's own format (#346).

The model's answer is checked key by key: a translation that loses a
placeholder or a tag never reaches a catalog. Writers add the missing keys
only, keep the file's layout, and escape the value for the format.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from i18n_agent.audit import audit, translate_catalogs
from i18n_agent.translator import BATCH_SIZE, check_translation, translate
from i18n_agent.writers import add_entries

RUNNER = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "backend"
    / "runners"
    / "i18n_runner.py"
)


def _write(root: Path, rel: str, text: str) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _echo(prefix: str = "[fr] "):
    """A fake model: the batch it receives, each text prefixed."""
    prompts: list[str] = []

    def ask(prompt: str, _project_dir: str | None) -> str:
        prompts.append(prompt)
        start = prompt.index("{\n")
        batch = json.loads(prompt[start : prompt.index("\n}", start) + 2])
        return json.dumps({k: prefix + v for k, v in batch.items()})

    ask.prompts = prompts  # type: ignore[attr-defined]
    return ask


# --- Checks on a translation ---------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "target", "reason"),
    [
        ("Hello {{name}}", "Bonjour {{name}}", ""),
        ("Hello {{name}}", "Bonjour {{nom}}", "placeholders"),
        ("%1$s files", "fichiers", "placeholders"),
        ("Click <b>here</b>", "Cliquez ici", "markup"),
        ("Save", "", "empty"),
        ("Save", "x" * 100, "too long"),
    ],
)
def test_a_translation_keeps_placeholders_and_tags(
    source: str, target: str, reason: str
) -> None:
    assert check_translation(source, target) == reason


def test_a_plural_form_may_add_the_count() -> None:
    assert check_translation("One file", "{{count}} fichier", "files_one") == ""
    assert check_translation("One file", "{{count}} fichier", "files") == "placeholders"


def test_the_catalog_is_quoted_as_data_and_sent_in_batches() -> None:
    ask = _echo()
    entries = {f"k{i}": f"Text number {i}" for i in range(BATCH_SIZE + 5)}

    result = translate(entries, "en", "fr", "common", ask=ask)

    assert len(ask.prompts) == 2
    assert all("<user_content>" in p for p in ask.prompts)
    assert result.translated["k0"] == "[fr] Text number 0" and result.answered


def test_a_key_the_model_did_not_answer_stays_missing() -> None:
    result = translate(
        {"a": "Save", "b": "Cancel"},
        "en",
        "fr",
        ask=lambda _p, _d: '{"a": "Enregistrer"}',
    )

    assert result.translated == {"a": "Enregistrer"} and result.rejected == {
        "b": "no answer"
    }


def test_no_model_writes_nothing() -> None:
    def broken(_p: str, _d: str | None) -> str:
        raise RuntimeError("no provider")

    result = translate({"a": "Save"}, "en", "fr", ask=broken)

    assert not result.answered and result.translated == {}


# --- Writers ------------------------------------------------------------------------------


def test_json_keeps_its_indentation_and_nests_dotted_keys(tmp_path: Path) -> None:
    path = _write(tmp_path, "fr.json", '{\n    "a": {\n        "b": "x"\n    }\n}\n')

    added = add_entries(path, "json", {"a.b": "no", "a.c": "é"}, {"a.b"})

    assert added == ["a.c"]
    assert (
        path.read_text(encoding="utf-8")
        == '{\n    "a": {\n        "b": "x",\n        "c": "é"\n    }\n}\n'
    )


def test_a_flat_json_catalog_stays_flat(tmp_path: Path) -> None:
    path = _write(tmp_path, "fr.json", '{"a.b": "x"}')

    add_entries(path, "json", {"a.c": "y"}, {"a.b"})

    assert json.loads(path.read_text(encoding="utf-8")) == {"a.b": "x", "a.c": "y"}


def test_android_values_are_escaped(tmp_path: Path) -> None:
    path = _write(tmp_path, "values-fr/strings.xml", "<resources>\n</resources>\n")

    added = add_entries(
        path, "android", {"title": '@l\'a "b" & <c>', "not.valid": "x"}, set()
    )

    assert added == ["title"]
    assert (
        '<string name="title">\\@l\\\'a \\"b\\" &amp; &lt;c&gt;</string>'
        in path.read_text(encoding="utf-8")
    )


def test_resx_properties_and_strings(tmp_path: Path) -> None:
    resx = _write(tmp_path, "S.fr.resx", "<root>\n</root>\n")
    props = _write(tmp_path, "m_fr.properties", "x=1")
    strings = _write(tmp_path, "fr.lproj/Localizable.strings", "")

    add_entries(resx, "resx", {"K": "a<b"}, set())
    add_entries(props, "properties", {"y": "é\n"}, set())
    add_entries(strings, "strings", {"k": 'a"b'}, set())

    assert "<value>a&lt;b</value>" in resx.read_text(encoding="utf-8")
    assert props.read_text(encoding="utf-8") == "x=1\ny=\\u00e9\\n\n"
    assert strings.read_text(encoding="utf-8") == '"k" = "a\\"b";\n'


def test_yaml_and_gettext_are_not_written(tmp_path: Path) -> None:
    path = _write(tmp_path, "config/locales/fr.yml", "fr:\n  a: b\n")

    assert add_entries(path, "yaml", {"c": "d"}, set()) == []
    assert path.read_text(encoding="utf-8") == "fr:\n  a: b\n"


def test_a_linked_catalog_is_not_written(tmp_path: Path) -> None:
    target = _write(tmp_path, "outside.json", "{}")
    link = tmp_path / "fr.json"
    try:
        os.symlink(target, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unavailable")

    assert add_entries(link, "json", {"a": "b"}, set()) == []
    assert target.read_text(encoding="utf-8") == "{}"


# --- The whole report and the translation run ---------------------------------------------


def _project(root: Path) -> Path:
    _write(
        root,
        "src/components/settings/PrivacyPanel.tsx",
        'import { useTranslation } from "react-i18next";\n'
        "export function PrivacyPanel() {\n"
        '  const { t } = useTranslation("common");\n'
        '  console.log("Loaded the privacy panel");\n'
        '  return (<div className="ml-4">\n'
        "    <label>Share anonymous benchmarks</label>\n"
        '    <p>{t("title")}</p>\n'
        "    <p>{t(`rules.${id}.title`)}</p>\n"
        "  </div>);\n"
        "}\n",
    )
    _write(
        root,
        "public/locales/en/common.json",
        json.dumps(
            {
                "title": "Settings",
                "greeting": "Hello {{name}}, welcome back to the app",
                "files_one": "One file",
                "files_other": "{{count}} files",
                "old": "Old unused text",
                "rules": {"a": {"title": "Rule A"}},
            },
            indent=2,
        ),
    )
    _write(
        root,
        "public/locales/fr/common.json",
        json.dumps(
            {
                "title": "Paramètres",
                "greeting": "Hello {{name}}, welcome back to the app",
                "files_one": "{{count}} fichier",
                "files_other": "{{count}} fichiers",
            },
            indent=2,
        ),
    )
    _write(
        root,
        "public/locales/ar/common.json",
        '{"title": "الإعدادات", "greeting": "مرحبا {{nom}}"}',
    )
    return root


def test_the_report_finds_each_kind_of_problem(tmp_path: Path) -> None:
    report = audit(_project(tmp_path), "en")
    by = {}
    for issue in report["issues"]:
        by.setdefault(issue["issueType"], []).append(issue)

    (hardcoded,) = by["hardcoded_string"]
    assert hardcoded["text"] == "Share anonymous benchmarks" and hardcoded[
        "snippet"
    ].startswith("{t(")
    assert {i["key"] for i in by["missing_key"] if i["locale"] == "fr"} == {
        "common.old",
        "common.rules.a.title",
    }
    assert [i["locale"] for i in by["inconsistent_params"]] == ["ar"]
    assert [i["key"] for i in by["untranslated"]] == ["common.greeting"]
    # rules.* is reached by a key built at run time; title is named.
    assert {i["key"] for i in by["orphan_key"]} == {
        "common.greeting",
        "common.old",
        "common.files_one",
        "common.files_other",
    }
    assert by["rtl_side"][0]["proposedValue"] == "ms" and report["rtlLocales"] == ["ar"]
    fr = next(c for c in report["completeness"] if c["locale"] == "fr")
    assert (fr["total"], fr["present"], fr["untranslated"], fr["missing"]) == (
        6,
        4,
        1,
        2,
    )
    assert report["translatable"] == {"ar": 4, "fr": 2}


def test_translation_adds_only_checked_keys(tmp_path: Path) -> None:
    root = _project(tmp_path)

    result = translate_catalogs(root, "en", ["fr"], ask=_echo())

    data = json.loads(
        (root / "public/locales/fr/common.json").read_text(encoding="utf-8")
    )
    assert result["added"] == 2 and result["written"][0]["locale"] == "fr"
    assert (
        data["old"] == "[fr] Old unused text"
        and data["rules"]["a"]["title"] == "[fr] Rule A"
    )
    assert data["title"] == "Paramètres"  # an existing value is never overwritten
    assert (
        json.loads(
            (root / "public/locales/ar/common.json").read_text(encoding="utf-8")
        )["title"]
        == "الإعدادات"
    )


def test_formats_that_are_not_written_are_listed(tmp_path: Path) -> None:
    _write(tmp_path, "config/locales/en.yml", "en:\n  hello: Hello\n  bye: Bye\n")
    _write(tmp_path, "config/locales/fr.yml", "fr:\n  hello: Bonjour\n")

    result = translate_catalogs(tmp_path, "en", None, ask=_echo())

    assert result["added"] == 0 and result["notWritable"] == ["config/locales/fr.yml"]


def test_the_runner_refuses_an_option_as_a_locale(tmp_path: Path) -> None:
    out = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(tmp_path),
            "--reference-locale",
            "--help",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    bad = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(tmp_path),
            "--locales",
            "fr,../x",
            "--translate",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert out.returncode != 0
    assert bad.returncode == 1 and 'I18N_ERROR:"Invalid locale"' in bad.stdout

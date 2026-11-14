"""The i18n report reads every stack's catalogs, not i18next JSON only.

Pointing the report at a .NET, Android, iOS, gettext, Flutter, Java, Rails
or Laravel project used to answer "no translation files found". The editor
stays JSON-only: it writes, and only JSON is written back.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from i18n_agent.catalogs import _php, _po
from i18n_scaler import I18nAutoScaler


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


RESX = """<?xml version="1.0" encoding="utf-8"?><root>
<data name="Welcome"><value>{welcome}</value></data>
{extra}</root>"""

STACKS = {
    "dotnet": (
        "resx",
        {
            "Resources/Strings.resx": RESX.format(
                welcome="Welcome", extra='<data name="Bye"><value>Bye</value></data>'
            ),
            "Resources/Strings.fr.resx": RESX.format(welcome="Bienvenue", extra=""),
        },
    ),
    "android": (
        "android",
        {
            "app/src/main/res/values/strings.xml": '<resources><string name="welcome">Welcome</string><string name="bye">Bye</string></resources>',
            "app/src/main/res/values-fr/strings.xml": '<resources><string name="welcome">Bienvenue</string></resources>',
        },
    ),
    "ios": (
        "strings",
        {
            "App/en.lproj/Localizable.strings": '"welcome" = "Welcome";\n"bye" = "Bye";\n',
            "App/fr.lproj/Localizable.strings": '"welcome" = "Bienvenue";\n',
        },
    ),
    "gettext": (
        "gettext",
        {
            "locale/en/LC_MESSAGES/messages.po": 'msgid "welcome"\nmsgstr "Welcome"\n\nmsgid "bye"\nmsgstr "Bye"\n',
            "locale/fr/LC_MESSAGES/messages.po": 'msgid "welcome"\nmsgstr "Bienvenue"\n',
        },
    ),
    "flutter": (
        "arb",
        {
            "lib/l10n/app_en.arb": '{"@@locale": "en", "welcome": "Welcome", "bye": "Bye", "@bye": {}}',
            "lib/l10n/app_fr.arb": '{"@@locale": "fr", "welcome": "Bienvenue"}',
        },
    ),
    "java": (
        "properties",
        {
            "src/main/resources/messages.properties": "welcome=Welcome\nbye=Bye\n",
            "src/main/resources/messages_fr.properties": "welcome=Bienvenue\n",
        },
    ),
    "rails": (
        "yaml",
        {
            "config/locales/en.yml": "en:\n  welcome: Welcome\n  bye: Bye\n",
            "config/locales/fr.yml": "fr:\n  welcome: Bienvenue\n",
        },
    ),
    "laravel": (
        "php",
        {
            "lang/en/messages.php": "<?php return ['welcome' => 'Welcome', 'bye' => 'Bye'];",
            "lang/fr/messages.php": "<?php return ['welcome' => 'Bienvenue'];",
        },
    ),
}


@pytest.mark.parametrize("stack", sorted(STACKS))
def test_report_finds_the_missing_french_key_on_every_stack(tmp_path, stack):
    fmt, files = STACKS[stack]
    for rel, text in files.items():
        _write(tmp_path / rel, text)
    found = I18nAutoScaler().discover_locales(tmp_path, catalogs=True)
    assert found.layout == "catalogs"
    assert found.formats == [fmt]
    assert {"en", "fr"} <= set(found.locales)
    report = I18nAutoScaler().report("en", found.locales).to_dict()
    [fr] = [d for d in report["diffs"] if d["target_locale"] == "fr"]
    missing = [k.rsplit(".", 1)[-1].lower() for k in fr["missing_keys"]]
    assert missing == ["bye"], (stack, fr)


def test_the_editor_still_sees_json_only(tmp_path):
    for rel, text in STACKS["dotnet"][1].items():
        _write(tmp_path / rel, text)
    assert I18nAutoScaler().discover_locales(tmp_path).layout == "none"


def test_gettext_reads_translations_and_continuation_lines():
    po = (
        'msgid ""\nmsgstr ""\n"Content-Type: text/plain\\n"\n\n'
        'msgid "Hello"\nmsgstr "Bonjour"\n\n'
        'msgid "Long "\n"text"\nmsgstr ""\n"Texte "\n"long"\n\n'
        'msgid "Todo"\nmsgstr ""\n'
    )
    assert _po(po) == {"Hello": "Bonjour", "Long text": "Texte long", "Todo": ""}


def test_laravel_reads_the_text_of_each_key():
    assert _php("<?php return ['a' => 'Un', \"b\" => \"Deux\"];") == {
        "a": "Un",
        "b": "Deux",
    }


def test_route_reports_a_dotnet_project_and_names_its_format(tmp_path):
    from i18n_scaler.api import router

    for rel, text in STACKS["dotnet"][1].items():
        _write(tmp_path / rel, text)
    app = FastAPI()
    app.include_router(router)
    res = (
        TestClient(app)
        .post("/api/i18n-scaler/report-from-dir", json={"locales_dir": str(tmp_path)})
        .json()
    )
    assert res["success"] is True
    assert res["layout"] == "catalogs" and res["formats"] == ["resx"]
    assert res["locales_found"] == ["en", "fr"]

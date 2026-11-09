"""What the i18n agent reads from code and catalogs, on every stack (#346).

Keys named by each stack's own call, the key proposed for a hard-coded string
in the project's style, placeholders and plural forms per language, copies of
the reference text, sides that do not mirror right to left. All of it without
a model.
"""

from __future__ import annotations

import pytest
from i18n_agent.i18n_scanner import I18nScanner, is_ui_file
from i18n_agent.keys import KeyStyle, detect_style, propose_key, snippet_for
from i18n_agent.parity import (
    missing_plural_categories,
    params_of,
    physical_sides,
    untranslated,
)
from i18n_agent.usage import collect_usage

# --- Keys the code uses ----------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "source", "key", "catalog"),
    [
        (
            "a.tsx",
            'const { t } = useTranslation("common"); t("save")',
            "save",
            "common",
        ),
        ("a.tsx", 't("common:save")', "save", "common"),
        ("a.tsx", '<Trans i18nKey="welcome.title" />', "welcome.title", "messages"),
        ("a.vue", "<p>{{ $t('menu.home') }}</p>", "menu.home", "messages"),
        ("a.html", "<p>{{ 'menu.home' | translate }}</p>", "menu.home", "messages"),
        ("a.ts", "this.translate.instant('menu.home')", "menu.home", "messages"),
        ("A.razor", '<p>@Localizer["Welcome"]</p>', "Welcome", "Strings"),
        ("A.cs", "label.Text = Resources.SaveButton;", "SaveButton", "Resources"),
        ("A.kt", "getString(R.string.app_name)", "app_name", "strings"),
        ("a.xml", 'android:text="@string/app_name"', "app_name", "strings"),
        ("A.swift", 'Text(String(localized: "greeting"))', "greeting", "Localizable"),
        ("a.dart", "AppLocalizations.of(context)!.helloWorld", "helloWorld", "arb"),
        ("a.py", '_("Save changes")', "Save changes", "gettext"),
        ("a.blade.php", "{{ __('auth.failed') }}", "failed", "auth"),
        ("a.erb", "<%= t('users.show.title') %>", "users.show.title", "en"),
    ],
)
def test_every_stack_names_its_keys(
    path: str, source: str, key: str, catalog: str
) -> None:
    assert collect_usage({path: source}).uses(key, catalog)


def test_a_key_built_at_run_time_marks_its_prefix() -> None:
    usage = collect_usage({"a.tsx": "t(`rules.${id}.title`); t('errors.' + code)"})

    assert usage.uses("rules.a.title") and usage.uses("errors.timeout")
    assert not usage.uses("other.key") and not usage.dynamic


def test_a_bare_variable_makes_every_orphan_uncertain() -> None:
    assert collect_usage({"a.tsx": "t(label)"}).dynamic


def test_plural_suffixes_belong_to_their_base_key() -> None:
    usage = collect_usage({"a.tsx": 't("files", { count })'})

    assert usage.uses("files_one") and usage.uses("files_other")


# --- Keys proposed for hard-coded text ---------------------------------------------


def test_the_key_follows_the_component_and_the_text() -> None:
    style = detect_style(["settings.title", "settings.saveButton"], "json")
    proposal = propose_key(
        "src/components/settings/PrivacyPanel.tsx",
        "Share anonymous benchmarks",
        style,
        {},
        set(),
    )

    assert proposal.key == "settings.privacyPanel.shareAnonymousBenchmarks"
    assert proposal.snippet == '{t("settings.privacyPanel.shareAnonymousBenchmarks")}'


def test_plural_forms_do_not_make_a_project_snake_case() -> None:
    assert detect_style(["title", "files_one", "files_other"], "json").case == "camel"


def test_an_existing_key_with_the_same_text_is_reused() -> None:
    proposal = propose_key("a.tsx", "Save", KeyStyle(), {"common.save": "Save"}, set())

    assert proposal.reused and proposal.key == "common.save"


def test_two_texts_never_get_the_same_key() -> None:
    taken: set[str] = set()
    first = propose_key("a/B.tsx", "Save", KeyStyle(), {}, taken)
    second = propose_key("a/B.tsx", "Save!", KeyStyle(), {}, taken)

    assert first.key != second.key


@pytest.mark.parametrize(
    ("fmt", "text", "value"),
    [
        ("json", "Hello {name}", "Hello {{name}}"),
        ("arb", "Hello ${user.name}", "Hello {name}"),
        ("android", "Hello {name}", "Hello %s"),
        ("strings", "Hello {name}", "Hello %@"),
        ("resx", "Hello {first} {last}", "Hello {0} {1}"),
        ("php", "Hello {name}", "Hello :name"),
    ],
)
def test_interpolations_take_the_catalog_s_placeholder(
    fmt: str, text: str, value: str
) -> None:
    style = detect_style([], fmt)

    assert propose_key("a.tsx", text, style, {}, set()).value == value


def test_android_keys_are_flat_snake_case() -> None:
    style = detect_style([], "android")
    proposal = propose_key(
        "app/src/main/java/ui/LoginScreen.kt", "Sign in", style, {}, set()
    )

    assert proposal.key == "login_screen_sign_in"
    assert proposal.snippet == "getString(R.string.login_screen_sign_in)"


@pytest.mark.parametrize(
    ("path", "snippet"),
    [
        ("a.vue", "{{ $t('k') }}"),
        ("a.svelte", "{$_('k')}"),
        ("app/a.component.html", "{{ 'k' | translate }}"),
        ("A.razor", '@Localizer["k"]'),
        ("a.blade.php", "{{ __('k') }}"),
        ("a.dart", "AppLocalizations.of(context)!.k"),
        ("A.swift", 'String(localized: "k")'),
        ("a.py", '_("k")'),
    ],
)
def test_the_snippet_is_the_stack_s_own_call(path: str, snippet: str) -> None:
    assert snippet_for(path, "k") == snippet


# --- Hard-coded text that is not interface text --------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "src/App.test.tsx",
        "src/__tests__/a.tsx",
        "Btn.stories.tsx",
        "tests/x.py",
        "UserTests.cs",
        "lib/a_test.dart",
    ],
)
def test_tests_and_stories_are_not_scanned(path: str) -> None:
    assert not is_ui_file(path)
    assert not I18nScanner().scan_file_for_hardcoded(path, "<h1>Welcome back home</h1>")


def test_a_class_named_like_contest_is_still_scanned() -> None:
    assert is_ui_file("Pages/Contest.cs")


def test_log_lines_are_not_interface_text() -> None:
    source = 'console.log("Loaded the settings page");\nlogger.info(title="Something happened")'

    assert I18nScanner().scan_file_for_hardcoded("a.tsx", source) == []


# --- Placeholders, copies and plural forms ---------------------------------------------


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("Hello {{ name }}", {"{{name}}"}),
        ("Hello {name}", {"{name}"}),
        ("{0} of {1}", {"{0}", "{1}"}),
        ("%1$s has %2$d items, %@", {"%1$s", "%2$d", "%@"}),
        ("Hi %{user}", {"%{user}"}),
        ("Hello :name", {":name"}),
    ],
)
def test_placeholders_of_every_format(text: str, found: set[str]) -> None:
    assert params_of(text) == found


def test_icu_plural_branches_may_differ() -> None:
    en = "{count, plural, one {# file} other {# files}}"
    fr = "{count, plural, one {# fichier} many {# de fichiers} other {# fichiers}}"

    assert params_of(en) == params_of(fr)


def test_a_short_label_identical_in_both_languages_is_not_a_copy() -> None:
    assert not untranslated("Description", "Description")
    assert untranslated("Save your changes now", "Save your changes now")


def test_arabic_needs_six_plural_forms() -> None:
    missing = dict(
        missing_plural_categories("ar", {"files_one": "a", "files_other": "b"})
    )

    assert missing == {"files": "zero, two, few, many"}


def test_japanese_needs_only_other() -> None:
    assert list(missing_plural_categories("ja", {"files_other": "x"})) == []


def test_french_many_is_asked_only_once_the_catalog_uses_it() -> None:
    old = {"a_one": "x", "a_other": "y"}
    recent = {**old, "b_one": "x", "b_many": "y", "b_other": "z"}

    assert list(missing_plural_categories("fr", old)) == []
    assert dict(missing_plural_categories("fr", recent)) == {"a": "many"}


def test_icu_messages_are_checked_per_language() -> None:
    message = {"files": "{n, plural, one {# plik} other {# plików}}"}

    assert dict(missing_plural_categories("pl", message)) == {"files": "few, many"}


# --- Right to left ---------------------------------------------------------------------


def test_physical_sides_in_css_and_utility_classes() -> None:
    css = physical_sides(
        "a.css",
        ".x { margin-left: 4px; text-align: right; }\n.y { inset-inline-start: 0 }",
    )
    jsx = physical_sides(
        "a.tsx",
        '<div className="flex ml-4 md:pr-2">x</div>\n<div className="ms-4">y</div>',
    )

    assert [line for line, _ in css] == [1]
    assert jsx == [(1, "ml-4")]

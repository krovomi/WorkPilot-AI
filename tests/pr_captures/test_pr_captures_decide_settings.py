"""Which tasks get captures, and what a team can decide about them."""

from __future__ import annotations

from pr_captures.decide import decide, screen_files
from pr_captures.settings import MAX_SELECTORS, CaptureSettings, load_settings


def test_defaults_publish_masked_captures_of_interface_changes(tmp_path):
    settings = load_settings(tmp_path, env={})
    assert settings == CaptureSettings()
    assert settings.mode == "auto"
    assert settings.publish == "auto"
    assert settings.mask is True
    assert settings.publish_unchecked is False


def test_the_project_file_is_read_and_a_real_variable_wins(tmp_path, monkeypatch):
    folder = tmp_path / ".workpilot"
    folder.mkdir()
    (folder / ".env").write_text(
        "CAPTURES_MODE=never\nCAPTURES_PUBLISH=review\nJIRA_TOKEN=x\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("CAPTURES_MODE", raising=False)
    monkeypatch.setenv("CAPTURES_PUBLISH", "never")
    settings = load_settings(tmp_path)
    assert settings.mode == "never"
    assert settings.decided_by == "project"
    assert settings.publish == "never"


def test_the_card_overrides_the_project(tmp_path):
    settings = load_settings(
        tmp_path, env={"CAPTURES_MODE": "never", "WORKPILOT_CAPTURES": "always"}
    )
    assert (settings.mode, settings.decided_by) == ("always", "task")
    following = load_settings(
        tmp_path, env={"CAPTURES_MODE": "never", "WORKPILOT_CAPTURES": "auto"}
    )
    assert (following.mode, following.decided_by) == ("never", "project")


def test_nonsense_values_fall_back_to_the_defaults(tmp_path):
    settings = load_settings(
        tmp_path,
        env={
            "CAPTURES_MODE": "sometimes",
            "CAPTURES_PUBLISH": "yes please",
            "CAPTURES_RETENTION_DAYS": "-4",
            "CAPTURES_MASK": "maybe",
        },
    )
    assert settings.mode == "auto"
    assert settings.publish == "auto"
    assert settings.retention_days == 30
    assert settings.mask is True


def test_mask_selectors_are_bounded(tmp_path):
    many = ",".join(f".pii-{i}" for i in range(MAX_SELECTORS + 10))
    long = "." + "a" * 300
    settings = load_settings(
        tmp_path,
        env={"CAPTURES_MASK_SELECTORS": f"{long}, .customer ,.customer,{many}"},
    )
    assert settings.mask_selectors[0] == ".customer"
    assert len(settings.mask_selectors) == MAX_SELECTORS
    assert long not in settings.mask_selectors


def test_every_stack_s_screens_count_and_tests_do_not():
    files = [
        "src/pages/Profile.tsx",
        "src/pages/Profile.test.tsx",
        "src/components/Card.stories.tsx",
        "Views/Home/Index.cshtml",
        "MainWindow.xaml",
        "lib/screens/orders.dart",
        "app/src/main/res/layout/activity_main.xml",
        "templates/orders.jinja2",
        "app/views/orders/index.html.erb",
        "resources/views/orders.blade.php",
        "Gestion/FEN_Clients.wdw",
        "Site/PAGE_Accueil.wwh",
        "api/orders.py",
        "README.md",
        "tests/e2e/profile.html",
    ]
    assert screen_files(files) == [
        "src/pages/Profile.tsx",
        "Views/Home/Index.cshtml",
        "MainWindow.xaml",
        "lib/screens/orders.dart",
        "app/src/main/res/layout/activity_main.xml",
        "templates/orders.jinja2",
        "app/views/orders/index.html.erb",
        "resources/views/orders.blade.php",
        "Gestion/FEN_Clients.wdw",
        "Site/PAGE_Accueil.wwh",
    ]


def test_windows_separators_are_read():
    assert screen_files(["src\\ui\\Login.vue"]) == ["src/ui/Login.vue"]


def test_the_decision_follows_the_files_and_the_setting():
    auto = CaptureSettings()
    assert decide(auto, ["web/App.vue"]).to_dict() == {
        "needed": True,
        "reason": "ui-files",
        "decidedBy": "default",
        "uiFiles": ["web/App.vue"],
    }
    assert decide(auto, ["api/orders.py"]).reason == "no-ui-files"
    assert decide(auto, []).reason == "no-changed-files"
    assert decide(auto, None).needed is False

    always = CaptureSettings(mode="always", decided_by="task")
    assert decide(always, ["api/orders.py"]).reason == "forced"
    assert decide(always, None).needed is True

    never = CaptureSettings(mode="never", decided_by="project")
    verdict = decide(never, ["web/App.vue"])
    assert (verdict.needed, verdict.reason) == (False, "turned-off")
    assert verdict.ui_files == ["web/App.vue"]


def test_a_team_s_own_captures_branch_is_kept_and_reported(tmp_path):
    settings = load_settings(tmp_path, env={"CAPTURES_BRANCH": "team/captures"})
    assert settings.branch == "team/captures"
    assert settings.to_dict()["branch"] == "team/captures"
    assert set(settings.to_dict()) == {
        "mode",
        "decidedBy",
        "compare",
        "mask",
        "maskSelectors",
        "publish",
        "publishUnchecked",
        "retentionDays",
        "branch",
    }
    assert load_settings(tmp_path, env={"CAPTURES_BRANCH": "../x"}).branch == (
        "workpilot-captures"
    )

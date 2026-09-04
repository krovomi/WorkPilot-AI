"""The mobile half of the agent chain: what each phase is told, and by whom.

Detection is tested in `test_mobile_stacks.py`. What matters here is that the
answer reaches the phases — the prompt section, the subagent roster, the
workflow phases — because a detector nobody reads specialises nothing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from agents.subagents.mobile import MOBILE_ROLES, overlay_for  # noqa: E402
from mobile.devices import parse_adb_devices  # noqa: E402
from mobile.prompt import TARGETS_ENV, mobile_section, requested_targets  # noqa: E402
from mobile.readiness import doctor  # noqa: E402
from mobile.stacks import ANDROID, IOS  # noqa: E402


@pytest.fixture
def flutter_app(tmp_path):
    (tmp_path / "android").mkdir()
    (tmp_path / "ios").mkdir()
    (tmp_path / "pubspec.yaml").write_text(
        "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
    )
    return tmp_path


@pytest.fixture
def android_app(tmp_path):
    (tmp_path / "app" / "src" / "main").mkdir(parents=True)
    (tmp_path / "settings.gradle.kts").write_text(
        'plugins { id("com.android.application") }', encoding="utf-8"
    )
    (tmp_path / "app" / "src" / "main" / "AndroidManifest.xml").write_text(
        "<manifest/>", encoding="utf-8"
    )
    return tmp_path


class TestTheDoctorIsHonestAboutTheMachine:
    def test_ios_off_macos_is_a_constraint_not_a_missing_package(
        self, monkeypatch, flutter_app
    ):
        monkeypatch.setattr("mobile.readiness._is_macos", lambda: False)
        report = doctor(flutter_app, platforms=(IOS,))[IOS]
        assert not report.ok
        assert "macos" in report.blocker.lower()
        # The remedy must not read "install xcodebuild": there is no package to
        # install, and an agent told there is will spend attempts looking for it.
        remedy = report.checks[0].remedy.lower()
        assert "mac runner" in remedy or "macos" in remedy

    def test_a_platform_with_its_tools_present_is_reported_ok(
        self, monkeypatch, android_app
    ):
        monkeypatch.setattr(
            "mobile.readiness.find_tool", lambda name: f"/usr/bin/{name}"
        )
        monkeypatch.setattr(
            "mobile.readiness.shutil.which", lambda name: f"/usr/bin/{name}"
        )
        assert doctor(android_app, platforms=(ANDROID,))[ANDROID].ok

    def test_the_emulator_is_optional_but_adb_is_not(self, monkeypatch, android_app):
        # Building needs adb; only *previewing* needs an emulator, so a machine
        # with the SDK but no emulator package still builds.
        monkeypatch.setattr(
            "mobile.readiness.find_tool",
            lambda name: "" if name == "emulator" else f"/usr/bin/{name}",
        )
        monkeypatch.setattr(
            "mobile.readiness.shutil.which",
            lambda name: None if name == "emulator" else f"/usr/bin/{name}",
        )
        report = doctor(android_app, platforms=(ANDROID,))[ANDROID]
        assert report.ok
        assert any(c.tool == "emulator" and not c.ok for c in report.checks)


class TestWhatThePhasesAreTold:
    def test_a_non_mobile_project_gets_no_section(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='x'\n", encoding="utf-8"
        )
        assert mobile_section(tmp_path) == ""

    def test_the_section_names_the_stack_and_its_commands(self, flutter_app):
        section = mobile_section(flutter_app, include_doctor=False)
        assert "flutter" in section
        assert "flutter build apk --debug" in section
        assert "flutter build ios --simulator --debug" in section

    def test_an_unbuildable_platform_is_stated_rather_than_hidden(
        self, monkeypatch, flutter_app
    ):
        monkeypatch.setattr("mobile.readiness._is_macos", lambda: False)
        section = mobile_section(flutter_app, targets=(IOS,))
        assert "What this machine cannot do" in section
        # The instruction that saves the cycle: report it, do not retry it.
        assert "went unverified" in section

    def test_platform_rules_are_scoped_to_the_targets(self, flutter_app):
        android_only = mobile_section(
            flutter_app, targets=(ANDROID,), include_doctor=False
        )
        assert "AndroidManifest.xml" in android_only
        assert "Info.plist" not in android_only

    def test_a_broken_project_dir_costs_the_section_not_the_build(self):
        assert mobile_section("/does/not/exist") == ""


class TestPerTaskTargets:
    def test_the_card_narrows_what_the_project_offers(self, monkeypatch, flutter_app):
        monkeypatch.setenv(TARGETS_ENV, "android")
        assert requested_targets(flutter_app) == (ANDROID,)

    def test_no_choice_means_every_platform_the_project_has(
        self, monkeypatch, flutter_app
    ):
        monkeypatch.delenv(TARGETS_ENV, raising=False)
        assert requested_targets(flutter_app) == (ANDROID, IOS)

    def test_asking_for_a_platform_the_project_lacks_is_ignored(
        self, monkeypatch, android_app
    ):
        # Obeying would mean planning an iOS build for a tree with no iOS head.
        monkeypatch.setenv(TARGETS_ENV, "ios")
        assert requested_targets(android_app) == (ANDROID,)


class TestTheRoster:
    def test_a_mobile_project_gains_the_device_and_store_specialists(self, flutter_app):
        overlay = overlay_for(flutter_app)
        assert overlay is not None
        assert set(overlay.extra_agents) == set(MOBILE_ROLES)

    def test_a_non_mobile_project_gains_nothing(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='x'\n", encoding="utf-8"
        )
        assert overlay_for(tmp_path) is None

    def test_the_overlay_carries_the_projects_own_commands(self, flutter_app):
        overlay = overlay_for(flutter_app)
        assert any("flutter test" in cmd for cmd in overlay.test_commands)
        assert any("flutter build apk" in cmd for cmd in overlay.build_commands)

    def test_one_command_for_two_platforms_is_listed_once(self, flutter_app):
        """`flutter test` covers both heads; listing it twice reads as two commands."""
        overlay = overlay_for(flutter_app)
        assert len([c for c in overlay.test_commands if "flutter test" in c]) == 1

    def test_the_specialists_survive_the_roster_cap(self, flutter_app):
        from agents.subagents import _apply_cap, _as_language_overlay

        overlay = overlay_for(flutter_app)
        roster = {f"filler-{i}": object() for i in range(10)}
        roster.update(_as_language_overlay(overlay).extra_agents)
        capped = _apply_cap(roster, {"test-runner", *MOBILE_ROLES})
        for role in MOBILE_ROLES:
            assert role in capped

    def test_the_device_runner_may_run_commands_and_the_auditor_may_not(
        self, flutter_app
    ):
        agents = overlay_for(flutter_app).extra_agents
        assert "Bash" in agents["device-runner"].tools
        # An auditor that can edit the manifest it is auditing is not auditing it.
        assert "Bash" not in agents["store-readiness-auditor"].tools
        assert "Edit" not in agents["store-readiness-auditor"].tools


class TestTheWorkflowPhases:
    @pytest.fixture
    def workflow(self):
        from workflows.spec import load_workflow

        return load_workflow(
            REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
        )

    def test_both_mobile_phases_are_declared(self, workflow):
        ids = [p.id for p in workflow.phases]
        assert "mobile-design" in ids
        assert "store-readiness" in ids

    def test_the_design_review_runs_before_the_code_is_written(self, workflow):
        """The window a phase runs in is its declared position, not its description."""
        ids = [p.id for p in workflow.phases]
        assert ids.index("mobile-design") < ids.index("coding")

    def test_the_store_audit_runs_after_qa(self, workflow):
        ids = [p.id for p in workflow.phases]
        assert ids.index("store-readiness") > ids.index("qa")

    def test_neither_runs_on_a_change_that_touches_no_mobile_file(self, workflow):
        from workflows.engine import resolve_profile

        profile = resolve_profile(
            workflow, "ultrathink", changed_files=["apps/backend/api/routes.py"]
        )
        running = {r.phase.id for r in profile.run}
        assert "mobile-design" not in running
        assert "store-readiness" not in running

    @pytest.mark.parametrize(
        "changed",
        [
            "app/src/main/AndroidManifest.xml",
            "ios/Runner/Info.plist",
            "lib/main.dart",
            "MyApp/MainPage.xaml",
            "app/src/main/java/com/acme/MainActivity.kt",
        ],
    )
    def test_they_run_on_a_change_that_does(self, workflow, changed):
        from workflows.engine import resolve_profile

        profile = resolve_profile(workflow, "high", changed_files=[changed])
        running = {r.phase.id for r in profile.run}
        assert "mobile-design" in running
        assert "store-readiness" in running

    def test_both_are_read_only_reviewers(self, workflow):
        from workflows.runner import SKILL_PHASE_AGENTS

        # `pr_reviewer` is what `create_client` puts in permission_mode "plan".
        assert SKILL_PHASE_AGENTS["mobile-design"] == "pr_reviewer"
        assert SKILL_PHASE_AGENTS["store-readiness"] == "pr_reviewer"

    def test_every_declared_phase_is_paid_for_as_one_of_the_four(self, workflow):
        from workflows.runner import _ELSEWHERE, BUILTIN_EXECUTORS, CONFIG_PHASE

        for phase in workflow.phases:
            if phase.id in BUILTIN_EXECUTORS or phase.pack in _ELSEWHERE:
                continue
            assert phase.id in CONFIG_PHASE, f"{phase.id} has no model/effort column"


class TestTheSkillsExist:
    @pytest.mark.parametrize(
        "skill",
        [
            "android-developer",
            "ios-developer",
            "cross-platform-mobile",
            "mobile-design-review",
            "mobile-device-testing",
            "mobile-store-readiness",
        ],
    )
    def test_the_pack_provides_what_the_workflow_and_the_docs_name(self, skill):
        assert (REPO_ROOT / "skills" / "mobile" / skill / "SKILL.md").is_file()

    def test_the_frontmatter_parses_with_the_shared_parser(self):
        from skills_registry.frontmatter import parse_frontmatter

        for skill_md in (REPO_ROOT / "skills" / "mobile").glob("*/SKILL.md"):
            meta, _ = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
            assert meta.get("name") == skill_md.parent.name
            assert meta.get("description")


class TestReadingAdbDevices:
    """`adb devices -l`, including the output adb produces when it is cold.

    Found by installing the real platform-tools and running the code against
    them rather than against a fixture: a cold adb writes two lines of its own
    before the header, and skipping a fixed first line left
    `* daemon started successfully` to be parsed as a device with the serial
    `*`. adb is cold exactly once per machine boot — which is the first time
    anyone opens the Mobile tab.
    """

    COLD = (
        "* daemon not running; starting now at tcp:5037\n"
        "* daemon started successfully\n"
        "List of devices attached\n"
        "\n"
    )

    def test_a_cold_adb_reports_no_phantom_devices(self):
        assert parse_adb_devices(self.COLD) == []

    def test_a_cold_adb_still_finds_the_real_ones(self):
        output = self.COLD.replace(
            "List of devices attached\n\n",
            "List of devices attached\nemulator-5554\tdevice model:Pixel_8\n",
        )
        (device,) = parse_adb_devices(output)
        assert device.id == "emulator-5554"
        assert device.kind == "emulator"
        assert device.name == "Pixel 8"

    def test_a_warm_adb_is_read_the_same_way(self):
        output = "List of devices attached\nemulator-5554\tdevice\n"
        assert [d.id for d in parse_adb_devices(output)] == ["emulator-5554"]

    def test_a_physical_phone_is_told_from_an_emulator(self):
        output = "List of devices attached\n1A2B3C4D\tdevice model:SM_G991B\n"
        (device,) = parse_adb_devices(output)
        assert device.kind == "physical"
        assert device.name == "SM G991B"

    @pytest.mark.parametrize("state", ["offline", "unauthorized", "connecting"])
    def test_a_device_that_cannot_be_installed_onto_is_not_offered(self, state):
        # Installing onto one fails with a message that reads like a broken
        # build; offering it in the picker is how that happens.
        output = f"List of devices attached\nemulator-5554\t{state}\n"
        assert parse_adb_devices(output) == []

    def test_chatter_that_survives_the_header_is_not_a_device(self):
        output = (
            "List of devices attached\n"
            "adb server version (41) doesn't match this client\n"
            "emulator-5554\tdevice\n"
        )
        assert [d.id for d in parse_adb_devices(output)] == ["emulator-5554"]

    def test_empty_output_is_an_answer(self):
        assert parse_adb_devices("") == []

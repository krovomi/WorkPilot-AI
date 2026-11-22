"""The feature flag a critical verdict turns off (#366, lot 4), against a fake provider."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from deploy_watch import watch
from deploy_watch.flags import flag_from_env, turn_off
from deploy_watch.rollback import RollbackPlan
from deploy_watch.watch import RUNS_FILE, run_rollback, run_watch, state_path

from .test_watch import HEALTH, MONITORS, RUN_ID, Clock

UNLEASH = {
    "CICD_ROLLBACK_FLAG_PROVIDER": "unleash",
    "CICD_ROLLBACK_FLAG_URL": "https://flags.example/",
    "CICD_ROLLBACK_FLAG_TOKEN": "unleash-test-0000",
    "CICD_ROLLBACK_FLAG_KEY": "new-checkout",
    "CICD_ROLLBACK_FLAG_ENVIRONMENT": "production",
}
UNLEASH_OFF = (
    "https://flags.example/api/admin/projects/default/features/new-checkout"
    "/environments/production/off"
)


def _flag(env: dict):
    problems: list[str] = []
    flag = flag_from_env(env, problems)
    assert flag is not None, problems
    return flag


class TestSettings:
    def test_no_flag(self):
        assert flag_from_env({}, []) is None

    @pytest.mark.parametrize(
        ("change", "problem"),
        [
            ({"CICD_ROLLBACK_FLAG_PROVIDER": "split"}, "CICD_ROLLBACK_FLAG_PROVIDER"),
            ({"CICD_ROLLBACK_FLAG_KEY": "a b"}, "key and the environment"),
            ({"CICD_ROLLBACK_FLAG_ENVIRONMENT": ""}, "key and the environment"),
            ({"CICD_ROLLBACK_FLAG_PROJECT": "../x"}, "CICD_ROLLBACK_FLAG_PROJECT"),
            (
                {"CICD_ROLLBACK_FLAG_URL": "http://flags.example"},
                "CICD_ROLLBACK_FLAG_URL",
            ),
            ({"CICD_ROLLBACK_FLAG_URL": "ftp://flags"}, "CICD_ROLLBACK_FLAG_URL"),
            ({"CICD_ROLLBACK_FLAG_TOKEN": ""}, "needs its token"),
            (
                {
                    "CICD_ROLLBACK_FLAG_PROVIDER": "launchdarkly",
                    "CICD_ROLLBACK_FLAG_URL": "",
                },
                "launchdarkly needs its token and project",
            ),
        ],
    )
    def test_refusals_are_named(self, change, problem):
        problems: list[str] = []
        assert flag_from_env({**UNLEASH, **change}, problems) is None
        assert problem in problems[0]

    def test_the_token_stays_out_of_repr(self):
        assert "unleash-test-0000" not in repr(_flag(UNLEASH))


class TestTurnOff:
    def test_unleash(self, fake_fetch):
        fetch = fake_fetch({UNLEASH_OFF: (200, b"")})
        result = turn_off(_flag(UNLEASH), fetch, offline=False)
        assert result == {
            "provider": "unleash",
            "key": "new-checkout",
            "environment": "production",
            "status": "done",
        }
        request = fetch.requests[0]
        assert request.get_method() == "POST"
        assert request.get_header("Authorization") == "unleash-test-0000"

    def test_launchdarkly_on_its_own_host(self, fake_fetch):
        env = {
            **UNLEASH,
            "CICD_ROLLBACK_FLAG_PROVIDER": "launchdarkly",
            "CICD_ROLLBACK_FLAG_URL": "",
            "CICD_ROLLBACK_FLAG_PROJECT": "shop",
        }
        url = "https://app.launchdarkly.com/api/v2/flags/shop/new-checkout"
        fetch = fake_fetch({url: (200, b"{}")})
        assert turn_off(_flag(env), fetch, offline=False)["status"] == "done"
        request = fetch.requests[0]
        assert request.get_method() == "PATCH"
        body = json.loads(request.data)
        assert body["instructions"] == [{"kind": "turnFlagOff"}]
        assert body["environmentKey"] == "production"

    def test_configcat_by_name_and_by_id(self, fake_fetch):
        env = {
            **UNLEASH,
            "CICD_ROLLBACK_FLAG_PROVIDER": "configcat",
            "CICD_ROLLBACK_FLAG_URL": "",
            "CICD_ROLLBACK_FLAG_PROJECT": "cfg-1",
            "CICD_ROLLBACK_FLAG_USER": "user",
        }
        base = "https://api.configcat.com/v1/environments/production/settings"
        fetch = fake_fetch(
            {
                f"{base}/new-checkout/value?configId=cfg-1": (200, b"{}"),
                f"{base}/42/value": (200, b"{}"),
            }
        )
        assert turn_off(_flag(env), fetch, offline=False)["status"] == "done"
        request = fetch.requests[0]
        assert request.get_method() == "PUT"
        assert json.loads(request.data) == {"value": False}
        expected = base64.b64encode(b"user:unleash-test-0000").decode()
        assert request.get_header("Authorization") == f"Basic {expected}"
        by_id = {
            **env,
            "CICD_ROLLBACK_FLAG_KEY": "42",
            "CICD_ROLLBACK_FLAG_PROJECT": "",
        }
        assert turn_off(_flag(by_id), fetch, offline=False)["status"] == "done"

    def test_failures(self, fake_fetch):
        flag = _flag(UNLEASH)
        assert (
            turn_off(flag, fake_fetch({UNLEASH_OFF: (403, b"")}), offline=False)[
                "status"
            ]
            == "failed"
        )
        assert turn_off(flag, fake_fetch(), offline=False)["status"] == "failed"

    def test_strict_offline_reaches_only_the_machine(self, fake_fetch):
        assert (
            turn_off(_flag(UNLEASH), fake_fetch(), offline=True)["status"] == "offline"
        )
        local = {**UNLEASH, "CICD_ROLLBACK_FLAG_URL": "http://127.0.0.1:4242"}
        url = (
            "http://127.0.0.1:4242/api/admin/projects/default/features/new-checkout"
            "/environments/production/off"
        )
        assert (
            turn_off(_flag(local), fake_fetch({url: (200, b"")}), offline=True)[
                "status"
            ]
            == "done"
        )


def _project(tmp_path: Path) -> Path:
    (tmp_path / ".workpilot").mkdir()
    (tmp_path / RUNS_FILE).write_text(
        json.dumps(
            [
                {
                    "id": RUN_ID,
                    "provider": "gitlab",
                    "triggered_at": "2026-11-15T10:00:00Z",
                }
            ]
        ),
        encoding="utf-8",
    )
    (tmp_path / ".workpilot" / "deploy-monitors.yaml").write_text(
        MONITORS, encoding="utf-8"
    )
    return tmp_path


class TestWatchChoosesTheFlag:
    def _watch(self, project, fetch, **env):
        clock = Clock()
        return run_watch(
            project,
            RUN_ID,
            {"CICD_MONITOR_HEALTH_URL": HEALTH, **UNLEASH, **env},
            fetch=fetch,
            sleep=clock.sleep,
            now=clock,
        )

    def test_the_flag_goes_off_and_nothing_is_redeployed(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        monkeypatch.setattr(watch, "plan_rollback", lambda *a: plan)
        # A migration does not stand in the way of a flag.
        monkeypatch.setattr(watch, "changed_paths", lambda *a: ["db/migrate/1_add.rb"])
        monkeypatch.setattr(
            watch, "execute_rollback", lambda *a: pytest.fail("must not redeploy")
        )
        fetch = fake_fetch({HEALTH: (503, b""), UNLEASH_OFF: (200, b"")})
        state = self._watch(_project(tmp_path), fetch, CICD_AUTO_ROLLBACK="true")
        assert (state["rollback"], state["strategy"], state["flag"]["status"]) == (
            "started",
            "flag",
            "done",
        )
        assert state["flag_configured"] is True
        assert "rollback_at" in state

    def test_a_flag_that_does_not_switch_falls_back_to_the_deployment(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        monkeypatch.setattr(watch, "plan_rollback", lambda *a: plan)
        monkeypatch.setattr(watch, "changed_paths", lambda *a: [])
        monkeypatch.setattr(watch, "execute_rollback", lambda *a: True)
        fetch = fake_fetch({HEALTH: (503, b""), UNLEASH_OFF: (500, b"")})
        state = self._watch(_project(tmp_path), fetch, CICD_AUTO_ROLLBACK="true")
        assert (state["rollback"], state["strategy"], state["flag"]["status"]) == (
            "started",
            "deployment",
            "failed",
        )

    def test_without_auto_rollback_the_flag_is_proposed(
        self, tmp_path, fake_fetch, monkeypatch
    ):
        monkeypatch.setattr(
            watch, "plan_rollback", lambda *a: RollbackPlan("gitlab", "manual")
        )
        monkeypatch.setattr(watch, "changed_paths", lambda *a: None)
        project = _project(tmp_path)
        state = self._watch(project, fake_fetch({HEALTH: (503, b"")}))
        assert state["rollback"] == "proposed"
        assert "flag" not in state

        # The person confirms: the flag goes off, even with GitLab.
        fetch = fake_fetch({UNLEASH_OFF: (200, b"")})
        after = run_rollback(project, RUN_ID, UNLEASH, fetch=fetch, now=Clock())
        assert (after["rollback"], after["strategy"], after["rollback_by"]) == (
            "started",
            "flag",
            "person",
        )
        # The flag does not answer: by hand, like GitLab without one.
        failing = fake_fetch({UNLEASH_OFF: (500, b"")})
        again = run_rollback(project, RUN_ID, UNLEASH, fetch=failing, now=Clock())
        assert (again["rollback"], again["flag"]["status"]) == ("manual", "failed")
        assert state_path(project, RUN_ID).is_file()

    def test_a_refused_flag_is_named(self, tmp_path, fake_fetch):
        project = _project(tmp_path)
        state = self._watch(
            project, fake_fetch({HEALTH: (200, b"")}), CICD_ROLLBACK_FLAG_KEY=""
        )
        assert state["flag_configured"] is False
        assert any("rollback flag" in p for p in state["problems"])

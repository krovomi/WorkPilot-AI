"""The hooks service as it runs: stored hooks, matching, every action it offers.

The service is the real one, keeping its files under a temporary
WORKPILOT_DATA_DIR. Only the webhook POST is replaced (`post_json`, the network
boundary, whose own rules are tested with the notifications).
"""

from __future__ import annotations

import asyncio
import json
import sys
from unittest.mock import patch

import pytest
from services.hooks import hook_service as hs
from services.hooks.hook_service import HookService
from services.hooks.models import (
    RETIRED_ACTION_TYPES,
    Action,
    ActionType,
    Hook,
    HookConnection,
    HookEvent,
    HookStatus,
    Trigger,
    TriggerCondition,
    TriggerType,
    without_retired_actions,
)
from services.hooks.templates import (
    get_hook_templates,
    get_template_by_id,
    get_templates_by_category,
)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(HookService, "_instance", None)
    return tmp_path


@pytest.fixture
def service(data_dir) -> HookService:
    return HookService.get_instance()


def _hooks_file(data_dir):
    return data_dir / "hooks" / "hooks.json"


def _store(data_dir, hooks: list[dict]) -> None:
    path = _hooks_file(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"hooks": hooks}), encoding="utf-8")


def _run(service: HookService, hook: Hook, data: dict | None = None) -> dict:
    event = HookEvent(type=TriggerType.MANUAL, data=data or {})
    return asyncio.run(service._execute_hook(hook, event)).to_dict()


def _one(action: Action, data: dict | None = None) -> dict:
    hook = Hook(name="h", triggers=[Trigger(type=TriggerType.MANUAL)])
    return asyncio.run(
        hs._execute_action(
            action, HookEvent(type=TriggerType.MANUAL, data=data or {}), hook
        )
    )


# ── Actions that did nothing are gone ────────────────────────────────────


def test_every_action_offered_is_one_the_service_carries_out():
    offered = {t.value for t in ActionType}

    assert offered == {
        "send_notification",
        "run_command",
        "send_slack",
        "send_teams",
        "send_discord",
        "send_google_chat",
        "send_webhook",
        "log_event",
    }
    assert offered.isdisjoint(RETIRED_ACTION_TYPES)


def test_a_stored_hook_loses_its_retired_actions_and_their_links(data_dir, caplog):
    _store(
        data_dir,
        [
            {
                "id": "h1",
                "name": "Lint then tell",
                "triggers": [{"id": "t1", "type": "manual"}],
                "actions": [
                    {"id": "a1", "type": "run_lint"},
                    {"id": "a2", "type": "log_event", "config": {"message": "x"}},
                    {"id": "a3", "type": "chain_hook"},
                ],
                "connections": [
                    {"source_id": "t1", "target_id": "a1"},
                    {"source_id": "a1", "target_id": "a2"},
                    {"source_id": "t1", "target_id": "a2"},
                    {"source_id": "a2", "target_id": "a3"},
                ],
            },
            {"id": "h2", "name": "Untouched", "actions": [{"type": "log_event"}]},
        ],
    )

    service = HookService.get_instance()

    hook = service.get_hook("h1")
    assert [a["id"] for a in hook["actions"]] == ["a2"]
    assert [(c["source_id"], c["target_id"]) for c in hook["connections"]] == [
        ("t1", "a2")
    ]
    assert service.get_hook("h2")["name"] == "Untouched"
    assert "lost the actions run_lint, chain_hook" in caplog.text

    # The next save writes the hook without them.
    service.toggle_hook("h2")
    saved = json.loads(_hooks_file(data_dir).read_text(encoding="utf-8"))
    types = {a["type"] for h in saved["hooks"] for a in h["actions"]}
    assert types == {"log_event"}


def test_a_hook_without_retired_actions_is_returned_as_is():
    data = {"actions": [{"type": "log_event"}, {}]}

    assert without_retired_actions(data) == (data, [])


def test_a_new_hook_naming_a_retired_action_is_refused(service):
    with pytest.raises(ValueError):
        service.create_hook({"name": "x", "actions": [{"type": "run_tests"}]})

    assert service.list_hooks() == []


def test_every_template_uses_only_actions_that_run():
    templates = get_hook_templates()

    assert templates
    for template in templates:
        hook = template.to_hook()
        assert hook.actions, template.id
        assert {a.type for a in hook.actions} <= set(ActionType)


def test_templates_by_category_and_by_id():
    by_category = get_templates_by_category()

    assert sum(len(v) for v in by_category.values()) == len(get_hook_templates())
    assert get_template_by_id("tpl-announce-pr-ready").name
    assert get_template_by_id("tpl-auto-lint-on-save") is None


# ── Matching ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("operator", "target", "value", "expected"),
    [
        ("equals", "main", "main", True),
        ("equals", "main", "dev", False),
        ("contains", "FIX", "hotfix/1", True),
        ("startsWith", "feat", "Feature/x", True),
        ("endsWith", ".PY", "a.py", True),
        ("matches", r"^v\d+$", "v12", True),
        ("matches", "(", "anything", False),
        ("glob", "*.ts", "app.ts", True),
        ("not_equals", "main", "dev", True),
        ("not_contains", "wip", "ready", True),
        ("teleport", "x", "x", False),
    ],
)
def test_a_condition_compares_the_event_field(operator, target, value, expected):
    condition = TriggerCondition(field="f", operator=operator, value=target)

    assert hs._match_condition(condition, {"f": value}) is expected


def test_a_list_or_dict_field_is_compared_as_text():
    condition = TriggerCondition(field="files", operator="contains", value="a.py")

    assert hs._match_condition(condition, {"files": ["a.py", "b.py"]})
    assert not hs._match_condition(condition, {})


def test_a_trigger_matches_its_type_then_all_its_conditions():
    trigger = Trigger(
        type=TriggerType.PR_OPENED,
        conditions=[TriggerCondition(field="branch", operator="equals", value="x")],
    )

    assert not hs._match_trigger(trigger, HookEvent(type=TriggerType.PR_MERGED))
    assert not hs._match_trigger(
        trigger, HookEvent(type=TriggerType.PR_OPENED, data={"branch": "y"})
    )
    assert hs._match_trigger(
        trigger, HookEvent(type=TriggerType.PR_OPENED, data={"branch": "x"})
    )


# ── Each action ──────────────────────────────────────────────────────────


def test_log_event_says_which_hook_fired():
    result = _one(Action(type=ActionType.LOG_EVENT))

    assert result["status"] == "success"
    assert result["output"] == {"message": "Hook 'h' triggered by manual"}


def test_send_notification_fills_its_text_from_the_event():
    action = Action(
        type=ActionType.SEND_NOTIFICATION,
        config={"title": "PR {{n}}", "message": "on {{branch}}", "type": "warning"},
    )

    result = _one(action, {"n": 7, "branch": "dev"})

    assert result["output"] == {
        "title": "PR 7",
        "message": "on dev",
        "type": "warning",
    }


def test_send_notification_has_defaults():
    result = _one(Action(type=ActionType.SEND_NOTIFICATION))

    assert result["output"] == {
        "title": "Hook Notification",
        "message": "",
        "type": "info",
    }


def test_a_delayed_action_waits_then_runs():
    result = _one(Action(type=ActionType.LOG_EVENT, delay_ms=1))

    assert result["status"] == "success"


def test_run_command_takes_event_data_as_one_argument_each(tmp_path):
    action = Action(
        type=ActionType.RUN_COMMAND,
        config={
            "command": [
                sys.executable,
                "-c",
                "import sys; print(sys.argv[1:])",
                "{{v}}",
            ],
            "cwd": str(tmp_path),
        },
    )

    result = _one(action, {"v": "a; rm -rf /"})

    assert result["status"] == "success"
    assert result["output"]["stdout"].strip() == "['a; rm -rf /']"
    assert result["output"]["return_code"] == 0


def test_run_command_splits_a_string_before_filling_it(tmp_path):
    script = tmp_path / "args.py"
    script.write_text("import sys; print(len(sys.argv) - 1)", encoding="utf-8")
    action = Action(
        type=ActionType.RUN_COMMAND,
        config={"command": f'"{sys.executable}" "{script}" {{{{v}}}}'},
    )

    result = _one(action, {"v": "one two three"})

    assert result["output"]["stdout"].strip() == "1"


def test_run_command_reports_a_non_zero_exit():
    action = Action(
        type=ActionType.RUN_COMMAND,
        config={"command": [sys.executable, "-c", "import sys; sys.exit(3)"]},
    )

    result = _one(action)

    assert result["status"] == "failed"
    assert result["error"] == "Command exited with code 3"


@pytest.mark.parametrize("command", [42, []])
def test_run_command_refuses_a_command_it_cannot_run(command):
    result = _one(Action(type=ActionType.RUN_COMMAND, config={"command": command}))

    assert result["status"] == "failed"
    assert "RUN_COMMAND" in result["error"]


def test_run_command_is_stopped_at_its_timeout():
    action = Action(
        type=ActionType.RUN_COMMAND,
        config={"command": [sys.executable, "-c", "import time; time.sleep(30)"]},
        timeout_ms=200,
    )

    result = _one(action)

    assert result["status"] == "timeout"
    assert result["error"] == "Action timed out after 200ms"


def test_send_webhook_needs_a_url():
    result = _one(Action(type=ActionType.SEND_WEBHOOK, config={}))

    assert result["status"] == "failed"
    assert "SEND_WEBHOOK requires" in result["error"]


def test_send_webhook_fills_a_custom_payload():
    action = Action(
        type=ActionType.SEND_WEBHOOK,
        config={
            "url": "https://hooks.example.com/x",
            "payload": {"text": "PR {{n}}", "count": 2},
        },
    )
    with patch.object(hs, "post_json", return_value=(False, 502, "HTTP 502")) as post:
        result = _one(action, {"n": 9})

    post.assert_called_once_with(
        "https://hooks.example.com/x", {"text": "PR 9", "count": 2}
    )
    assert result["status"] == "failed"
    assert result["error"] == "HTTP 502"
    assert result["output"]["status"] == "failed"


def test_a_channel_action_needs_a_url(monkeypatch):
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    result = _one(Action(type=ActionType.SEND_SLACK, config={"message": "hi"}))

    assert result["status"] == "failed"
    assert "SLACK_WEBHOOK_URL" in result["error"]


def test_a_channel_action_without_text_needs_pr_data():
    action = Action(type=ActionType.SEND_TEAMS, config={"url": "https://t.example"})

    result = _one(action, {"title": "no pr here"})

    assert result["status"] == "failed"
    assert "no PR data" in result["error"]


def test_a_channel_action_builds_a_card_from_a_pr_ready_event():
    action = Action(
        type=ActionType.SEND_GOOGLE_CHAT, config={"url": "https://g.example"}
    )
    with patch.object(hs, "post_json", return_value=(False, None, "unreachable")):
        result = _one(action, {"event": "pr_ready", "title": "Ship it"})

    assert result["status"] == "failed"
    assert result["output"]["channel"] == "google_chat"


# ── A hook's graph ───────────────────────────────────────────────────────


def _logged(action_id: str) -> Action:
    return Action(
        id=action_id, type=ActionType.LOG_EVENT, config={"message": action_id}
    )


def _failing(action_id: str) -> Action:
    return Action(id=action_id, type=ActionType.SEND_WEBHOOK, config={})


def test_connections_follow_success_failure_and_always(service):
    hook = Hook(
        name="graph",
        triggers=[Trigger(id="t", type=TriggerType.MANUAL)],
        actions=[
            _failing("bad"),
            _logged("after-failure"),
            _logged("after-success"),
            _logged("always"),
            _logged("never"),
            _logged("unlinked"),
        ],
        connections=[
            HookConnection("t", "bad"),
            HookConnection("t", "missing"),
            HookConnection("bad", "after-failure", condition="on_failure"),
            HookConnection("bad", "never", condition="on_success"),
            HookConnection("after-failure", "after-success", condition="on_success"),
            HookConnection("after-success", "always", condition="always"),
            HookConnection("always", "bad"),
        ],
    )

    execution = _run(service, hook)

    ran = [r["action_id"] for r in execution["action_results"]]
    assert ran == ["bad", "after-failure", "after-success", "always"]
    assert execution["status"] == "failed"
    assert hook.error_count == 1


def test_without_connections_every_action_runs(service):
    hook = Hook(name="flat", actions=[_logged("a"), _logged("b")])

    execution = _run(service, hook)

    assert {r["action_id"] for r in execution["action_results"]} == {"a", "b"}
    assert execution["status"] == "success"
    assert hook.execution_count == 1
    assert hook.error_count == 0


def test_a_hook_whose_action_timed_out_has_failed(service):
    hook = Hook(
        name="slow",
        actions=[
            Action(
                type=ActionType.RUN_COMMAND,
                config={
                    "command": [sys.executable, "-c", "import time; time.sleep(30)"]
                },
                timeout_ms=200,
            )
        ],
    )

    execution = _run(service, hook)

    assert execution["action_results"][0]["status"] == "timeout"
    assert execution["status"] == "failed"
    assert hook.error_count == 1


def test_executions_are_kept_to_the_most_recent(service):
    service._max_executions = 2
    hook = Hook(name="h", actions=[_logged("a")])
    for _ in range(3):
        _run(service, hook)

    assert len(service.get_executions()) == 2
    assert service.get_executions(hook_id="other") == []
    assert len(service.get_executions(hook_id=hook.id, limit=1)) == 1


# ── Events ───────────────────────────────────────────────────────────────


def _manual_hook(service: HookService, **fields) -> dict:
    return service.create_hook(
        {
            "name": "m",
            "triggers": [{"type": "manual"}],
            "actions": [{"type": "log_event"}],
            **fields,
        }
    )


def test_an_event_runs_the_active_hooks_of_its_project(service):
    mine = _manual_hook(service, project_id="p1")
    _manual_hook(service, project_id="p2")
    shared = _manual_hook(service, project_id="p3", cross_project=True)
    paused = _manual_hook(service, project_id="p1")
    service.toggle_hook(paused["id"])
    _manual_hook(service, project_id="p1", triggers=[{"type": "pr_opened"}])

    results = asyncio.run(
        service.emit_event(HookEvent(type=TriggerType.MANUAL, project_id="p1"))
    )

    assert {r["hook_id"] for r in results} == {mine["id"], shared["id"]}


def test_an_event_without_project_runs_every_matching_hook(service):
    _manual_hook(service, project_id="p1")
    _manual_hook(service, project_id="p2")

    results = service.emit_event_sync(HookEvent(type=TriggerType.MANUAL))

    assert len(results) == 2


def test_the_sync_emitter_works_from_inside_a_running_loop(service):
    _manual_hook(service)

    async def inside():
        return service.emit_event_sync(HookEvent(type=TriggerType.MANUAL))

    assert len(asyncio.run(inside())) == 1


def test_a_merge_with_a_spec_id_is_credited_to_the_learning_loop(service, monkeypatch):
    import learning_loop.observe as observe

    credited = []
    monkeypatch.setattr(
        observe,
        "record_merge_outcome",
        lambda root, spec: credited.append(spec) or 1,
    )

    asyncio.run(
        service.emit_event(
            HookEvent(type=TriggerType.PR_MERGED, data={"specId": " 012-x "})
        )
    )
    asyncio.run(service.emit_event(HookEvent(type=TriggerType.PR_MERGED, data={})))
    asyncio.run(service.emit_event(HookEvent(type=TriggerType.PR_OPENED)))

    assert credited == ["012-x"]


def test_a_merge_credit_that_fails_does_not_stop_the_hooks(service, monkeypatch):
    import learning_loop.observe as observe

    def broken(root, spec):
        raise OSError("ledger locked")

    monkeypatch.setattr(observe, "record_merge_outcome", broken)
    _manual_hook(service, triggers=[{"type": "pr_merged"}])
    monkeypatch.setattr(observe, "record_merge_outcome", broken)

    results = asyncio.run(
        service.emit_event(
            HookEvent(type=TriggerType.PR_MERGED, data={"spec_id": "001"})
        )
    )

    assert len(results) == 1


def test_a_merge_that_credits_nothing_is_quiet(service, monkeypatch):
    import learning_loop.observe as observe

    monkeypatch.setattr(observe, "record_merge_outcome", lambda root, spec: 0)

    assert (
        asyncio.run(
            service.emit_event(
                HookEvent(type=TriggerType.PR_MERGED, data={"spec_id": "001"})
            )
        )
        == []
    )


# ── Storage and CRUD ─────────────────────────────────────────────────────


def test_hooks_and_executions_survive_a_restart(data_dir, service):
    hook = _manual_hook(service)
    service.emit_event_sync(HookEvent(type=TriggerType.MANUAL))

    HookService._instance = None
    again = HookService.get_instance()

    assert again.get_hook(hook["id"])["execution_count"] == 1
    assert len(again.get_executions()) == 1
    assert again.get_stats() == {
        "total_hooks": 1,
        "active_hooks": 1,
        "paused_hooks": 0,
        "total_executions": 1,
        "total_errors": 0,
        "success_rate": 100.0,
        "recent_executions": 1,
    }


def test_unreadable_files_leave_an_empty_service(data_dir, caplog):
    folder = data_dir / "hooks"
    folder.mkdir()
    (folder / "hooks.json").write_text("{not json", encoding="utf-8")
    (folder / "executions.json").write_text("[]", encoding="utf-8")

    service = HookService.get_instance()

    assert service.list_hooks() == []
    assert service.get_executions() == []
    assert "Failed to load hooks" in caplog.text
    assert "Failed to load executions" in caplog.text


def test_a_save_that_fails_is_logged(service, monkeypatch, tmp_path, caplog):
    not_a_folder = tmp_path / "file"
    not_a_folder.write_text("", encoding="utf-8")
    monkeypatch.setattr(hs, "_get_hooks_file", lambda: not_a_folder / "hooks.json")
    monkeypatch.setattr(
        hs, "_get_executions_file", lambda: not_a_folder / "executions.json"
    )

    _manual_hook(service)
    service.emit_event_sync(HookEvent(type=TriggerType.MANUAL))

    assert "Failed to save hooks" in caplog.text
    assert "Failed to save executions" in caplog.text


def test_the_data_folder_defaults_to_the_home_folder(monkeypatch, tmp_path):
    monkeypatch.delenv("WORKPILOT_DATA_DIR", raising=False)
    monkeypatch.setattr(hs.Path, "home", lambda: tmp_path)

    assert hs._get_hooks_dir() == tmp_path / ".workpilot" / "hooks"


def test_crud_on_a_missing_hook_answers_none(service):
    assert service.get_hook("nope") is None
    assert service.update_hook("nope", {"name": "x"}) is None
    assert service.delete_hook("nope") is False
    assert service.toggle_hook("nope") is None
    assert service.duplicate_hook("nope") is None
    assert service.create_from_template("nope") is None


def test_update_keeps_the_creation_date_and_toggle_goes_both_ways(service):
    hook = _manual_hook(service)

    updated = service.update_hook(hook["id"], {"name": "renamed"})
    assert updated["name"] == "renamed"
    assert updated["created_at"] == hook["created_at"]

    assert service.toggle_hook(hook["id"])["status"] == HookStatus.PAUSED.value
    assert service.toggle_hook(hook["id"])["status"] == HookStatus.ACTIVE.value
    assert [h.id for h in service.active_hooks()] == [hook["id"]]


def test_a_template_becomes_a_hook_of_the_project(service):
    hook = service.create_from_template("tpl-notify-pr-opened", project_id="p1")

    assert hook["project_id"] == "p1"
    assert service.list_hooks("p1") == [hook]
    assert len(service.get_templates()) == len(get_hook_templates())


def test_a_service_made_by_another_thread_meanwhile_is_the_one_returned(
    data_dir, monkeypatch
):
    made_elsewhere = HookService.__new__(HookService)

    class OtherThreadWonTheRace:
        def __enter__(self):
            HookService._instance = made_elsewhere

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(HookService, "_instance_lock", OtherThreadWonTheRace())

    assert HookService.get_instance() is made_elsewhere

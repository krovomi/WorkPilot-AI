"""JEV is opt-in; a key or malformed configuration cannot enable it."""

import json

import pytest
from integrations.jev.models import JevContext, JevSettings, JevSettingsError
from integrations.jev.settings import bypass_reason, consume_api_key, settings_from_env


def test_defaults_and_key_alone(tmp_path):
    cfg = settings_from_env({"TYPESAFE_API_KEY": "test-key"})
    assert cfg == JevSettings()
    assert (
        bypass_reason(cfg, JevContext("feature-build", tmp_path), has_key=True)
        == "disabled"
    )


@pytest.mark.parametrize(
    ("enabled", "mode", "expected"),
    [
        (False, "inherit", "disabled"),
        (True, "inherit", None),
        (False, "enabled", None),
        (True, "bypass", "workflow_bypass"),
        (False, "bypass", "workflow_bypass"),
    ],
)
def test_workflow_mode(tmp_path, enabled, mode, expected):
    cfg = JevSettings(enabled=enabled, workflows={"github-review": mode})
    assert (
        bypass_reason(cfg, JevContext("github-review", tmp_path), has_key=True)
        == expected
    )
    assert bypass_reason(cfg, JevContext("gitlab-review", tmp_path), has_key=True) == (
        None if enabled else "disabled"
    )


def test_missing_key_and_offline(tmp_path):
    ctx = JevContext("feature-build", tmp_path)
    cfg = JevSettings(enabled=True)
    assert bypass_reason(cfg, ctx, has_key=False) == "missing_key"
    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir()
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")
    assert bypass_reason(cfg, ctx, has_key=True) == "offline"


def test_server_does_not_use_desktop_key(tmp_path):
    assert (
        bypass_reason(
            JevSettings(enabled=True),
            JevContext("feature-build", tmp_path, server_mode=True),
            has_key=True,
        )
        == "unsupported_context"
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("ENABLED", "perhaps"),
        ("WORKFLOW_MODES", "[]"),
        ("WORKFLOW_MODES", '{"feature-build":"unknown"}'),
        ("WORKFLOW_MODES", "{"),
        ("MINIMUM_CONFIDENCE", "nan"),
        ("MINIMUM_CONFIDENCE", "2"),
        ("TIMEOUT_SECONDS", "-1"),
        ("TIMEOUT_SECONDS", "inf"),
        ("MODEL", ""),
    ],
)
def test_invalid_settings(name, value):
    with pytest.raises(JevSettingsError):
        settings_from_env({"WORKPILOT_JEV_" + name: value})


def test_false_string_and_overrides():
    cfg = settings_from_env(
        {
            "WORKPILOT_JEV_ENABLED": "false",
            "WORKPILOT_JEV_WORKFLOW_MODES": '{"github-review":"enabled"}',
        }
    )
    assert cfg.enabled is False
    assert cfg.workflows["github-review"] == "enabled"


def test_consume_removes_secret_even_if_empty():
    env = {"TYPESAFE_API_KEY": " test-key ", "OTHER": "keep"}
    assert consume_api_key(env) == "test-key"
    assert env == {"OTHER": "keep"}
    assert consume_api_key({"TYPESAFE_API_KEY": "  "}) is None


def test_settings_snapshot_cannot_be_mutated():
    original = {"feature-build": "bypass"}
    cfg = JevSettings(workflows=original)
    original["feature-build"] = "enabled"
    assert cfg.workflows["feature-build"] == "bypass"
    with pytest.raises(TypeError):
        cfg.workflows["feature-build"] = "enabled"

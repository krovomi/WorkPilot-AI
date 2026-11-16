"""The settings JSON the app passes to every agent process, read as data."""

from __future__ import annotations

import json

import pytest
from security.agent_safety_settings import (
    ENV_VAR,
    AgentSafetySettings,
    load_settings,
    normalize_allowed_path,
    parse_settings,
)


def test_absent_or_broken_settings_are_the_defaults():
    assert load_settings({}) == AgentSafetySettings()
    assert load_settings({ENV_VAR: "{not json"}) == AgentSafetySettings()
    assert load_settings({ENV_VAR: "[1, 2]"}) == AgentSafetySettings()
    defaults = AgentSafetySettings()
    assert defaults.snapshots.enabled and defaults.anomaly.enabled
    assert defaults.sandbox.mode == "normal"


def test_every_field_is_read():
    settings = load_settings(
        {
            ENV_VAR: json.dumps(
                {
                    "snapshots": {"enabled": False, "keep": 3, "autoRollback": False},
                    "sandbox": {
                        "mode": "restricted",
                        "allowedPaths": [{"path": "src/"}, "tests\\unit"],
                        "maxFilesWritten": 50,
                        "maxFileSizeMb": 2.5,
                        "maxSessionMinutes": 90,
                    },
                    "anomaly": {
                        "enabled": False,
                        "pauseBelow": 50,
                        "stopBelow": 30,
                        "massDeletionCount": 8,
                        "maxErrorCount": 12,
                        "rapidChangeWindowS": 20,
                    },
                }
            )
        }
    )
    assert (settings.snapshots.enabled, settings.snapshots.keep) == (False, 3)
    assert settings.snapshots.auto_rollback is False
    assert settings.sandbox.allowed_paths == ("src", "tests/unit")
    assert settings.sandbox.max_file_size_mb == 2.5
    assert settings.sandbox.max_session_minutes == 90
    assert settings.anomaly.thresholds()["trust_score_pause_threshold"] == 50
    assert settings.anomaly.thresholds()["mass_deletion_count"] == 8


@pytest.mark.parametrize(
    "raw,expected",
    [
        ({"snapshots": {"keep": 10_000}}, 50),
        ({"snapshots": {"keep": -3}}, 1),
        ({"snapshots": {"keep": "7"}}, 10),
        ({"snapshots": {"keep": True}}, 10),
    ],
)
def test_numbers_are_typed_and_bounded(raw, expected):
    assert parse_settings(raw).snapshots.keep == expected


def test_the_stop_threshold_never_exceeds_the_pause_threshold():
    settings = parse_settings({"anomaly": {"pauseBelow": 30, "stopBelow": 80}})
    assert settings.anomaly.stop_below == 30


def test_an_unknown_mode_is_normal():
    assert parse_settings({"sandbox": {"mode": "docker"}}).sandbox.mode == "normal"


@pytest.mark.parametrize(
    "entry", ["/etc", "C:\\Windows", "../outside", "src/../../x", "", ".", 42, None]
)
def test_an_allowed_path_never_leaves_the_project(entry):
    assert normalize_allowed_path(entry) is None


def test_allowed_paths_are_deduplicated_and_capped():
    raw = {"sandbox": {"allowedPaths": ["src", "src/", *[f"p{i}" for i in range(80)]]}}
    paths = parse_settings(raw).sandbox.allowed_paths
    assert paths[0] == "src" and paths.count("src") == 1 and len(paths) == 50

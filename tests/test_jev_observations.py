import json

from integrations.jev.observations import read_observations, write_observation


def test_missing_invalid_and_oversized(tmp_path):
    assert read_observations(tmp_path) is None
    target = tmp_path / "jev-evaluations.json"
    for content in ("not-json", "[]", '{"version":1}', "x" * (256 * 1024 + 1)):
        target.write_text(content, encoding="utf-8")
        assert read_observations(tmp_path) is None


def test_valid_roundtrip_and_no_temporary_files(tmp_path):
    record = {
        "version": 1,
        "runId": "run1",
        "workflow": "feature-build",
        "evaluations": [
            {
                "point": "classification",
                "passId": "planning",
                "revision": "r1",
                "status": "bypassed",
                "reason": "disabled",
                "answers": {},
                "model": None,
                "usage": {},
                "createdAt": "2026-09-23",
            }
        ],
    }
    write_observation(tmp_path, record)
    assert read_observations(tmp_path) == record
    assert [p.name for p in tmp_path.iterdir()] == ["jev-evaluations.json"]


def test_write_failure_is_optional(tmp_path):
    target = tmp_path / "not-a-directory"
    target.write_text("keep", encoding="utf-8")
    write_observation(target, {})
    assert target.read_text(encoding="utf-8") == "keep"


def test_unknown_fields_cannot_echo_secrets(tmp_path):
    (tmp_path / "jev-evaluations.json").write_text(
        json.dumps(
            {
                "version": 1,
                "runId": "r",
                "workflow": "feature-build",
                "evaluations": [],
                "key": "never-return",
            }
        ),
        encoding="utf-8",
    )
    result = read_observations(tmp_path)
    assert result is None or "key" not in result

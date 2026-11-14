"""« Exposition de l'artefact »: REA's checks read into a verdict (lot B)."""

from __future__ import annotations

from pathlib import Path

from rea import ReaLauncher, ReaRun, ReaUnavailable
from rea.artifacts import Artifact
from rea.exposure import (
    FAIL,
    PASS,
    UNCHECKED,
    audit,
    blocking_checks,
    load_record,
    write_record,
)

LAUNCHER = ReaLauncher(
    argv=("node", "rea.mjs"),
    source="installed",
    node_version="22.23.4",
    version="6.9.0",
)


def check(id_: str, status: str, severity: str | None = "high", **extra) -> dict:
    return {
        "id": id_,
        "status": status,
        "severity": severity,
        "remediation": f"fix {id_}",
        "observation": {"samples": ["a.js.map", "b.js.map", "c.js.map", "d.js.map"]},
        **extra,
    }


def runner_answering(*answers: ReaRun):
    calls: list[tuple] = []
    queue = list(answers)

    def run(command, positionals, options=None, **kwargs) -> ReaRun:
        calls.append((command, list(positionals), dict(options or {}), kwargs))
        return queue.pop(0)

    run.calls = calls  # type: ignore[attr-defined]
    return run


def artifact(tmp_path: Path, name: str = "dist") -> Artifact:
    path = tmp_path / name
    path.mkdir(exist_ok=True)
    return Artifact(path=path.resolve(), kind="web")


def test_only_an_exposed_check_at_the_threshold_blocks() -> None:
    checks = [
        check("high.exposed", "exposed", "high"),
        check("medium.exposed", "exposed", "medium"),
        check("high.unknown", "unknown", "high"),
        check("high.not_assessed", "not_assessed", "high"),
        check("high.not_observed", "not_observed", "high"),
        check("none", "exposed", None),
    ]
    assert [c["id"] for c in blocking_checks(checks, "high")] == ["high.exposed"]
    assert [c["id"] for c in blocking_checks(checks, "medium")] == [
        "high.exposed",
        "medium.exposed",
    ]
    # An unknown threshold reads as the default, never as "block everything".
    assert [c["id"] for c in blocking_checks(checks, "typo")] == ["high.exposed"]


def test_an_exposed_check_fails_and_is_kept_short(tmp_path: Path) -> None:
    run = runner_answering(
        ReaRun(
            ok=True,
            exit_code=3,
            result={
                "checks": [
                    check("web.source_maps", "exposed", "high"),
                    check("web.debug", "unknown", "high"),
                ]
            },
        )
    )
    report = audit(
        tmp_path, launcher=LAUNCHER, artifacts=[artifact(tmp_path)], runner=run
    )
    assert report.status == FAIL
    assert report.rea == "rea-agents@6.9.0 (installed)"
    [(where, blocking)] = report.blocking
    assert where.path == "dist"
    assert blocking["id"] == "web.source_maps"
    assert blocking["samples"] == ["a.js.map", "b.js.map", "c.js.map"]
    assert "observation" not in blocking
    command, positionals, options, kwargs = run.calls[0]
    assert command == "audit-release-exposure"
    assert positionals == [(tmp_path / "dist").resolve()]
    assert options == {"--fail_on": "high"}
    assert kwargs["launcher"] is LAUNCHER


def test_unknown_and_not_assessed_never_fail(tmp_path: Path) -> None:
    run = runner_answering(
        ReaRun(
            ok=True,
            exit_code=0,
            result={
                "checks": [
                    check("a", "unknown"),
                    check("b", "not_assessed"),
                    check("c", "exposed", "low"),
                ]
            },
        )
    )
    report = audit(
        tmp_path, launcher=LAUNCHER, artifacts=[artifact(tmp_path)], runner=run
    )
    assert report.status == PASS
    assert report.blocking == []


def test_an_artifact_rea_could_not_read_is_unknown_not_a_pass(tmp_path: Path) -> None:
    run = runner_answering(
        ReaRun(ok=True, exit_code=0, result={"checks": [check("a", "not_observed")]}),
        ReaRun(ok=False, error="timeout", detail="900 s"),
    )
    report = audit(
        tmp_path,
        launcher=LAUNCHER,
        artifacts=[artifact(tmp_path, "dist"), artifact(tmp_path, "out")],
        runner=run,
    )
    assert report.status == UNCHECKED
    assert "1 of 2" in report.unchecked
    assert [a.status for a in report.artifacts] == [PASS, UNCHECKED]
    assert report.artifacts[1].detail.startswith("timeout")


def test_a_report_without_checks_decides_nothing(tmp_path: Path) -> None:
    run = runner_answering(ReaRun(ok=True, exit_code=0, result={"checks": []}))
    report = audit(
        tmp_path, launcher=LAUNCHER, artifacts=[artifact(tmp_path)], runner=run
    )
    assert report.status == UNCHECKED


def test_no_rea_or_no_build_output_is_unknown(tmp_path: Path) -> None:
    run = runner_answering()
    missing = audit(
        tmp_path,
        launcher=ReaUnavailable(reason="offline", detail="strict offline mode"),
        runner=run,
    )
    assert missing.status == UNCHECKED
    assert "offline" in missing.unchecked
    empty = audit(tmp_path, launcher=LAUNCHER, runner=run)
    assert empty.status == UNCHECKED
    assert "no build output" in empty.unchecked
    assert run.calls == []


def test_the_record_round_trips(tmp_path: Path) -> None:
    run = runner_answering(
        ReaRun(ok=True, exit_code=3, result={"checks": [check("x", "exposed")]})
    )
    report = audit(
        tmp_path,
        launcher=LAUNCHER,
        fail_on="medium",
        mode="strict",
        artifacts=[artifact(tmp_path)],
        runner=run,
    )
    write_record(tmp_path / "spec", report)
    record = load_record(tmp_path / "spec")
    assert record is not None
    assert record["status"] == FAIL
    assert record["fail_on"] == "medium"
    assert record["mode"] == "strict"
    assert record["artifacts"][0]["checks"][0]["blocking"] is True


def test_an_unreadable_record_is_none(tmp_path: Path) -> None:
    assert load_record(tmp_path) is None
    (tmp_path / "artifact_exposure.json").write_text("[1]", encoding="utf-8")
    assert load_record(tmp_path) is None
    (tmp_path / "artifact_exposure.json").write_text("{", encoding="utf-8")
    assert load_record(tmp_path) is None

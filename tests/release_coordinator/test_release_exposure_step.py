"""The release train's « Exposition de l'artefact » step (lot B of REA).

Declared per service, it runs before ``deploy``: REA's static audit of the
build output the service ships. Exposed at its threshold stops the train; a
missing artifact or REA unable to run is an error, never a pass; a service
stopped there never deployed, so a rollback leaves it alone.
"""

from __future__ import annotations

import pytest
from rea import ReaLauncher, ReaRun, ReaUnavailable
from release_coordinator.gates import StepResult, run_exposure, run_step
from release_coordinator.train import Context, drive, start
from release_coordinator.train_file import Step, TrainFileError, parse

LAUNCHER = ReaLauncher(
    argv=("node", "rea.mjs"),
    source="installed",
    node_version="22.23.4",
    version="6.9.0",
)

TRAIN = """
environments:
  staging: {}
services:
  - name: api
    deploy: {command: [./deploy.sh]}
    rollback: {command: [./rollback.sh]}
  - name: desktop
    path: apps/desktop
    depends_on: [api]
    exposure: {artifact: dist/linux-unpacked, fail_on: medium, timeout: 120}
    deploy: {command: [./deploy.sh]}
    rollback: {command: [./rollback.sh]}
"""


def test_the_exposure_step_parses_and_runs_first() -> None:
    desktop = parse(TRAIN.encode()).services["desktop"]
    assert desktop.exposure == Step(
        timeout=120, artifact="dist/linux-unpacked", fail_on="medium"
    )
    assert list(desktop.steps())[:2] == ["exposure", "deploy"]
    assert desktop.exposure.to_dict()["artifact"] == "dist/linux-unpacked"
    assert desktop.exposure.to_dict()["failOn"] == "medium"
    assert "artifact" not in desktop.deploy.to_dict()
    defaults = parse(
        TRAIN.replace(", fail_on: medium, timeout: 120", "").encode()
    ).services["desktop"]
    assert (defaults.exposure.fail_on, defaults.exposure.timeout) == ("high", 900)


@pytest.mark.parametrize(
    ("exposure", "message"),
    [
        ("{artifact: ../../etc}", "inside the service folder"),
        ("{artifact: /usr/bin}", "inside the service folder"),
        ("{artifact: ''}", "inside the service folder"),
        ("{artifact: dist, fail_on: critical}", "fail_on must be"),
        ("{artifact: dist, command: [rm, -rf, /]}", "unknown key command"),
        ("[dist]", "must be a mapping"),
    ],
)
def test_an_exposure_step_that_does_not_hold_is_refused(
    exposure: str, message: str
) -> None:
    text = TRAIN.replace(
        "{artifact: dist/linux-unpacked, fail_on: medium, timeout: 120}", exposure
    )
    with pytest.raises(TrainFileError, match=message):
        parse(text.encode())


def _rea(answer: ReaRun, seen: list | None = None):
    def run(command, positionals, options=None, **kwargs) -> ReaRun:
        if seen is not None:
            seen.append((command, list(positionals), options, kwargs))
        return answer

    return run


def _project(tmp_path):
    (tmp_path / "apps" / "desktop" / "dist" / "linux-unpacked").mkdir(parents=True)
    return tmp_path


STEP = Step(artifact="dist/linux-unpacked", fail_on="medium", timeout=120)


def test_an_exposed_check_at_the_threshold_fails_the_step(tmp_path) -> None:
    root = _project(tmp_path)
    seen: list = []
    answer = ReaRun(
        ok=True,
        exit_code=3,
        result={
            "checks": [
                {
                    "id": "electron.run_as_node",
                    "status": "exposed",
                    "severity": "medium",
                },
                {"id": "electron.asar", "status": "unknown", "severity": "high"},
            ]
        },
    )
    result = run_exposure(
        STEP,
        root=root,
        folder="apps/desktop",
        rea_runner=_rea(answer, seen),
        locator=lambda **_: LAUNCHER,
    )
    assert result.status == "failed"
    assert "electron.run_as_node (medium)" in result.detail
    assert "electron.asar" not in result.detail
    command, positionals, options, kwargs = seen[0]
    assert command == "audit-release-exposure"
    assert positionals == [(root / "apps/desktop/dist/linux-unpacked").resolve()]
    assert options == {"--fail_on": "medium"}
    assert kwargs["timeout"] == 120


def test_unknown_or_below_the_threshold_passes(tmp_path) -> None:
    answer = ReaRun(
        ok=True,
        exit_code=0,
        result={
            "checks": [
                {"id": "a", "status": "unknown", "severity": "high"},
                {"id": "b", "status": "not_assessed", "severity": "high"},
                {"id": "c", "status": "exposed", "severity": "low"},
            ]
        },
    )
    result = run_exposure(
        STEP,
        root=_project(tmp_path),
        folder="apps/desktop",
        rea_runner=_rea(answer),
        locator=lambda **_: LAUNCHER,
    )
    assert result.status == "passed"


def test_a_missing_or_outside_artifact_or_no_rea_is_an_error(tmp_path) -> None:
    root = _project(tmp_path)
    never = _rea(ReaRun(ok=True, result={"checks": []}))
    missing = run_exposure(
        Step(artifact="dist/nothing"),
        root=root,
        folder="apps/desktop",
        rea_runner=never,
        locator=lambda **_: LAUNCHER,
    )
    assert missing.status == "error" and "build the service first" in missing.detail
    outside = run_exposure(
        Step(artifact="../../.."),
        root=root,
        folder="apps/desktop",
        rea_runner=never,
        locator=lambda **_: LAUNCHER,
    )
    assert outside.status == "error" and "outside the project" in outside.detail
    no_rea = run_exposure(
        STEP,
        root=root,
        folder="apps/desktop",
        rea_runner=_rea(ReaRun(ok=False, error="unavailable", detail="node_missing")),
        locator=lambda **_: ReaUnavailable(reason="node_missing", detail="no node"),
    )
    assert no_rea.status == "error" and "REA did not answer" in no_rea.detail
    slow = run_exposure(
        STEP,
        root=root,
        folder="apps/desktop",
        rea_runner=_rea(ReaRun(ok=False, error="timeout", detail="120 s")),
        locator=lambda **_: LAUNCHER,
    )
    assert slow.status == "timeout"


def test_run_step_sends_an_exposure_step_to_rea(tmp_path, monkeypatch) -> None:
    import release_coordinator.gates as gates

    seen: list = []
    monkeypatch.setattr(
        gates,
        "run_exposure",
        lambda step, **kw: seen.append(step) or StepResult("passed"),
    )
    assert run_step(STEP, root=tmp_path, folder="", values={}, pass_env=[]).ok
    assert seen == [STEP]


class Steps:
    def __init__(self, exposure: str) -> None:
        self.exposure = exposure
        self.calls: list[tuple[str, str]] = []

    def __call__(
        self, step: Step, *, values: dict[str, str], **_: object
    ) -> StepResult:
        kind = "exposure" if step.artifact else step.command[0]
        self.calls.append((values["service"], kind))
        if kind == "exposure":
            return StepResult(self.exposure, detail="exposed at medium or above: x")
        return StepResult("passed")


def test_a_failed_exposure_stops_before_deploy_and_is_not_rolled_back(tmp_path) -> None:
    steps = Steps("failed")
    ctx = Context(
        root=tmp_path,
        train=parse(TRAIN.encode()),
        step_runner=steps,
        flag_switch=lambda *a: {},
    )
    versions = {"api": ("1", "2"), "desktop": ("1", "2")}
    run = drive(ctx, start(ctx, "staging", versions)["id"])
    assert run["status"] == "blocked"
    assert run["blocked"]["step"] == "exposure"
    assert steps.calls == [("api", "./deploy.sh"), ("desktop", "exposure")]
    assert run["gateFailures"] == 1
    run = drive(ctx, run["id"], "rollback", "api")
    assert ("desktop", "./rollback.sh") not in steps.calls
    assert ("api", "./rollback.sh") in steps.calls
    items = {i["service"]: i for i in run["items"]}
    assert items["desktop"]["detail"] == "never deployed: nothing to roll back"
    assert items["api"]["status"] == "rolled_back"

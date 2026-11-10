"""Release Train (#362): train file, waves, gates, flags, calendar, notes, runs."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from release_coordinator import runs  # noqa: E402
from release_coordinator.flags import build_request, switch, token_names  # noqa: E402
from release_coordinator.gates import (  # noqa: E402
    GateError,
    StepResult,
    check_url,
    command_env,
    run_command,
    substitute,
)
from release_coordinator.graph import cascade, plan_order  # noqa: E402
from release_coordinator.notes import release_notes  # noqa: E402
from release_coordinator.schedule import calendar, conflicts  # noqa: E402
from release_coordinator.train import (  # noqa: E402
    Context,
    TrainError,
    drive,
    start,
    view,
)
from release_coordinator.train_file import (  # noqa: E402
    Flag,
    Step,
    TrainFileError,
    find,
    parse,
)

TRAIN = """
environments:
  staging: {}
  production: {production: true}
services:
  - name: db
    external: true
  - name: auth
    criticality: high
    depends_on: [db]
    deploy: {command: [./deploy.sh, "{environment}", "{version}"]}
    rollback: {command: [./rollback.sh, "{previous_version}"]}
    health: {url: "https://auth.example.test/health"}
  - name: api
    depends_on: [auth]
    deploy: {command: [./deploy.sh, "{environment}", "{version}"]}
    rollback: {command: [./rollback.sh, "{previous_version}"]}
    smoke: {command: [./smoke.sh]}
  - name: web
    depends_on: [api]
    deploy: {command: [./deploy.sh, "{environment}", "{version}"]}
    rollback: {command: [./rollback.sh, "{previous_version}"]}
flags:
  - {key: checkout, services: [api, web], provider: unleash, url: "https://flags.example.test", project: shop}
calendar:
  - {service: api, environment: production, at: "2026-11-12T14:00:00Z", minutes: 60}
  - {service: web, environment: production, at: "2026-11-12T14:30:00Z", minutes: 30}
  - {service: web, environment: staging, at: "2026-11-12T14:30:00Z"}
"""


# --- the train file ---------------------------------------------------------


def test_the_train_file_parses_every_part() -> None:
    train = parse(TRAIN.encode())
    assert list(train.services) == ["db", "auth", "api", "web"]
    assert train.environments == {"staging": False, "production": True}
    assert train.services["db"].external and train.services["db"].deploy is None
    assert train.services["auth"].health.url.startswith("https://")
    assert train.flags[0].url == "https://flags.example.test"
    assert len(train.sha256) == 64


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (
            "services: [{name: a, deploy: {command: './deploy.sh prod'}}]",
            "list of arguments",
        ),
        (
            "services: [{name: a, deploy: {command: [x, '{token}']}}]",
            "unknown placeholder",
        ),
        (
            "services: [{name: a, path: ../other, deploy: {command: [x]}}]",
            "inside the project",
        ),
        ("services: [{name: a, health: {command: [curl, x]}}]", "not a command"),
        ("services: [{name: a, health: {}}]", "needs a url"),
        ("services: [{name: a, deploy: {url: 'https://x.test'}}]", "not a URL"),
        ("services: [{name: a, deploy: {command: [-rf]}}]", "start with the program"),
        ("services: [{name: a}, {name: a}]", "listed twice"),
        ("services: [{name: a, pass_env: ['A B']}]", "is not a name"),
        (
            "calendar: [{service: a, environment: prod, at: '2026-11-12T14:00:00'}]",
            "time zone",
        ),
        ("flags: [{key: f, provider: homemade}]", "provider must be"),
        ("!!python/object/apply:os.system ['true']", "not YAML"),
    ],
)
def test_a_train_file_that_does_not_hold_is_refused(text: str, message: str) -> None:
    with pytest.raises(TrainFileError, match=message):
        parse(text.encode())


def test_a_linked_train_file_is_not_read(tmp_path: Path) -> None:
    outside = tmp_path / "outside.yaml"
    outside.write_text("services: []", encoding="utf-8")
    project = tmp_path / "project"
    project.mkdir()
    (project / "release-train.yaml").symlink_to(outside)
    assert find(project) is None
    (project / ".workpilot").mkdir()
    (project / ".workpilot" / "release-train.yaml").write_text(
        "services: []", encoding="utf-8"
    )
    assert find(project) == project / ".workpilot" / "release-train.yaml"


def test_an_oversized_train_file_is_refused() -> None:
    with pytest.raises(TrainFileError, match="64 KB"):
        parse(b"#" * (64 * 1024 + 1))


# --- the order ----------------------------------------------------------------


def test_waves_follow_dependencies_and_criticality() -> None:
    order = plan_order(
        {"web": {"api"}, "api": {"auth"}, "auth": set(), "mail": set(), "docs": set()},
        {"mail": "low", "auth": "high"},
    )
    assert order.waves == [["auth", "docs", "mail"], ["api"], ["web"]]
    assert order.cycle == []


def test_a_cycle_is_named_with_a_link_to_cut() -> None:
    order = plan_order(
        {"a": {"b"}, "b": {"c"}, "c": {"a"}, "d": set()}, {"a": "high", "c": "low"}
    )
    assert order.waves == [["d"]]
    assert sorted(order.cycle) == ["a", "b", "c"]
    assert order.suggestion is not None and order.suggestion[0] == "c"


def test_unknown_dependencies_are_reported_not_waited_for() -> None:
    order = plan_order({"api": {"auth", "ghost"}, "auth": set()})
    assert order.waves == [["auth"], ["api"]]
    assert order.unknown == {"api": ["ghost"]}


def test_a_rollback_takes_the_shipped_dependents_first() -> None:
    deps = {"auth": set(), "api": {"auth"}, "web": {"api"}, "mail": set()}
    assert cascade(
        deps, "auth", ["auth", "api", "mail"], ["auth", "mail", "api", "web"]
    ) == ["api", "auth"]
    assert cascade(deps, "api", ["auth", "api", "web"], ["auth", "api", "web"]) == [
        "web",
        "api",
    ]


# --- the steps ----------------------------------------------------------------


def test_placeholders_take_only_safe_values() -> None:
    assert (
        substitute(
            "{environment}-{version}", {"environment": "prod", "version": "1.2.0"}
        )
        == "prod-1.2.0"
    )
    with pytest.raises(GateError, match="characters"):
        substitute("{version}", {"version": "1.0 & calc"})
    with pytest.raises(GateError, match="no value"):
        substitute("{previous_version}", {"previous_version": ""})


def _script(folder: Path, name: str, body: str) -> None:
    path = folder / name
    path.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
    path.chmod(0o755)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell scripts")
def test_a_command_runs_without_credentials_but_with_its_declared_variables(
    tmp_path: Path,
) -> None:
    _script(
        tmp_path,
        "deploy.sh",
        'echo "env=$1 key=${API_TOKEN:-none} profile=${AWS_PROFILE:-none}"',
    )
    source = {**os.environ, "API_TOKEN": "s3cret", "AWS_PROFILE": "prod"}
    result = run_command(
        Step(command=["./deploy.sh", "{environment}"]),
        root=tmp_path,
        folder="",
        values={"environment": "staging"},
        pass_env=["AWS_PROFILE"],
        source_env=source,
    )
    assert result.ok, result
    assert "env=staging key=none profile=prod" in result.output
    assert "API_TOKEN" not in command_env([], source)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell scripts")
def test_a_failing_or_hanging_command_says_so(tmp_path: Path) -> None:
    _script(tmp_path, "fail.sh", "echo boom; exit 4")
    _script(tmp_path, "hang.sh", "sleep 30")
    failed = run_command(
        Step(command=["./fail.sh"]), root=tmp_path, folder="", values={}, pass_env=[]
    )
    assert (failed.status, failed.exit_code, failed.output.strip()) == (
        "failed",
        4,
        "boom",
    )
    hung = run_command(
        Step(command=["./hang.sh"], timeout=1),
        root=tmp_path,
        folder="",
        values={},
        pass_env=[],
    )
    assert hung.status == "timeout"


def test_a_program_outside_the_project_or_missing_runs_nothing(tmp_path: Path) -> None:
    (tmp_path / "app").mkdir()
    started: list[object] = []

    def popen(*args: object, **kwargs: object) -> subprocess.Popen:
        started.append(args)
        raise AssertionError("nothing should start")

    for command, folder in (
        (["../../bin/sh", "-c", "id"], "app"),
        (["./missing.sh"], "app"),
        (["no-such-program-wp"], "app"),
    ):
        result = run_command(
            Step(command=command),
            root=tmp_path,
            folder=folder,
            values={},
            pass_env=[],
            popen=popen,
        )
        assert result.status == "error"
    assert (
        run_command(
            Step(command=["x"]), root=tmp_path, folder="nope", values={}, pass_env=[]
        ).status
        == "error"
    )
    assert started == []


def test_a_health_url_is_retried_until_it_answers() -> None:
    answers = iter([0, 503, 200])
    waits: list[float] = []
    result = check_url(
        Step(url="https://{service}.example.test/health", retries=5),
        {"service": "auth"},
        fetch=lambda url: next(answers),
        sleep=waits.append,
    )
    assert (result.status, result.attempts, len(waits)) == ("passed", 3, 2)
    never = check_url(
        Step(url="https://x.test", retries=2),
        {},
        fetch=lambda url: 500,
        sleep=lambda s: None,
    )
    assert never.status == "failed" and "got 500" in never.detail


# --- the flags ------------------------------------------------------------------


def test_each_provider_gets_its_own_call_and_the_token_stays_out_of_the_result() -> (
    None
):
    unleash = build_request(
        Flag("checkout", [], "unleash", "shop", "", "https://u.test"),
        True,
        "production",
        {"UNLEASH_API_TOKEN": "tok"},
    )
    assert unleash.method == "POST"
    assert (
        unleash.url
        == "https://u.test/api/admin/projects/shop/features/checkout/environments/production/on"
    )
    assert unleash.headers["Authorization"] == "tok"
    ld = build_request(
        Flag("checkout", [], "launchdarkly", "shop"),
        False,
        "prod",
        {"LAUNCHDARKLY_API_TOKEN": "t"},
    )
    assert (
        ld.method == "PATCH"
        and ld.url == "https://app.launchdarkly.com/api/v2/flags/shop/checkout"
    )
    assert "semanticpatch" in ld.headers["Content-Type"]
    assert json.loads(ld.body)["instructions"] == [{"kind": "turnFlagOff"}]
    cc = build_request(
        Flag("checkout", [], "configcat", "cfg-1", "env-1"),
        True,
        "prod",
        {"CONFIGCAT_API_USER": "u", "CONFIGCAT_API_PASSWORD": "p"},
    )
    assert (
        cc.url
        == "https://api.configcat.com/v1/environments/env-1/settings/checkout/value?configId=cfg-1"
    )
    assert json.loads(cc.body) == {"value": True}
    assert build_request(Flag("f", [], "manual"), True, "prod", {}) is None

    sent = switch(
        Flag("checkout", [], "unleash", "shop", "", "https://u.test"),
        True,
        "production",
        {"UNLEASH_API_TOKEN": "tok"},
        sender=lambda request: 401,
    )
    assert sent["status"] == "failed" and "tok" not in json.dumps(sent)
    missing = switch(
        Flag("f", [], "launchdarkly", "p"), True, "prod", {}, sender=lambda r: 200
    )
    assert missing["status"] == "failed" and "LAUNCHDARKLY_API_TOKEN" in str(
        missing["detail"]
    )
    assert token_names([Flag("a", [], "configcat"), Flag("b", [], "manual")]) == [
        "CONFIGCAT_API_PASSWORD",
        "CONFIGCAT_API_USER",
    ]


# --- the calendar and the notes ---------------------------------------------------


def test_slots_that_overlap_in_one_environment_collide() -> None:
    train = parse(TRAIN.encode())
    assert conflicts(train.calendar) == [(0, 1)]
    page = calendar(train.calendar, datetime(2026, 11, 12, 9, tzinfo=UTC))
    assert [s["conflict"] for s in page["slots"]] == [True, True, False]
    assert calendar(train.calendar, datetime(2026, 11, 13, tzinfo=UTC))["slots"] == []


PLAN = {
    "services": [
        {
            "name": "api",
            "currentVersion": {"major": 1, "minor": 2, "patch": 0},
            "nextVersion": {"major": 1, "minor": 3, "patch": 0},
            "bumpType": "minor",
            "changelogEntries": [
                "- **cart:** add coupons (feat)",
                "- crash on empty cart (fix)",
            ],
        },
        {"name": "docs", "bumpType": "none", "changelogEntries": []},
    ]
}


def test_notes_come_from_the_commits_and_the_model_only_adds_a_paragraph() -> None:
    notes = release_notes(PLAN, "Release 2026-11-10")
    assert notes["by"] == "rules"
    text = str(notes["markdown"])
    assert (
        "## api 1.2.0 → 1.3.0 (minor)" in text
        and "### Features" in text
        and "docs" not in text
    )
    prompts: list[str] = []

    def ask(prompt: str, project_dir: str | None) -> str:
        prompts.append(prompt)
        return "Coupons arrive in the cart, and an empty cart no longer crashes."

    with_model = release_notes(PLAN, "Release", ai=True, ask=ask)
    assert with_model["by"] == "model" and "Coupons arrive" in str(
        with_model["markdown"]
    )
    assert "</user_content>" in prompts[0] or "untrusted" in prompts[0].lower()
    bad = release_notes(
        PLAN, "Release", ai=True, ask=lambda p, d: "# Heading\n\n- list"
    )
    assert bad["by"] == "rules"


# --- the runs -----------------------------------------------------------------------


class Steps:
    """Records each step and answers what the test says."""

    def __init__(self, failing: set[tuple[str, str]] | None = None) -> None:
        self.calls: list[tuple[str, str, dict[str, str]]] = []
        self.failing = failing or set()

    def __call__(
        self, step: Step, *, folder: str, values: dict[str, str], **_: object
    ) -> StepResult:
        kind = (
            "rollback"
            if step.command[:1] == ["./rollback.sh"]
            else "url"
            if step.url
            else step.command[0]
        )
        self.calls.append((values["service"], kind, dict(values)))
        if (values["service"], kind) in self.failing:
            return StepResult("failed", detail="exit code 1", exit_code=1)
        return StepResult("passed")


def _context(
    tmp_path: Path, steps: Steps, flags: list[dict[str, object]] | None = None
) -> Context:
    def flag_switch(
        flag: Flag, on: bool, environment: str, env: object
    ) -> dict[str, object]:
        (flags if flags is not None else []).append({"key": flag.key, "on": on})
        return {
            "key": flag.key,
            "provider": flag.provider,
            "on": on,
            "status": "done",
            "detail": "",
        }

    return Context(
        root=tmp_path,
        train=parse(TRAIN.encode()),
        step_runner=steps,
        flag_switch=flag_switch,
    )


VERSIONS = {
    "auth": ("1.0.0", "1.1.0"),
    "api": ("2.0.0", "2.1.0"),
    "web": ("3.0.0", "3.0.0"),
}


def test_staging_ships_in_order_with_gates_and_turns_the_flag_on(
    tmp_path: Path,
) -> None:
    steps, flags = Steps(), []
    ctx = _context(tmp_path, steps, flags)
    run = start(ctx, "staging", VERSIONS)
    run = drive(ctx, run["id"])
    # db is external: the person says it is ready, even in staging.
    assert run["status"] == "waiting" and run["items"][0]["service"] == "db"
    run = drive(ctx, run["id"], "confirm", "db")
    assert run["status"] == "done", run["journal"]
    assert [(s, k) for s, k, _ in steps.calls] == [
        ("auth", "./deploy.sh"),
        ("auth", "url"),
        ("api", "./deploy.sh"),
        ("api", "./smoke.sh"),
        ("web", "./deploy.sh"),
    ]
    assert steps.calls[0][2]["version"] == "1.1.0"
    assert flags == [{"key": "checkout", "on": True}]
    assert runs.last_shipped(tmp_path, "staging") == {
        "auth": "1.1.0",
        "api": "2.1.0",
        "web": "3.0.0",
    }


def test_production_waits_for_a_click_before_each_service(tmp_path: Path) -> None:
    steps = Steps()
    ctx = _context(tmp_path, steps)
    run = drive(ctx, start(ctx, "production", VERSIONS, services=["auth", "api"])["id"])
    assert run["status"] == "waiting" and steps.calls == []
    run = drive(ctx, run["id"], "confirm", "auth")
    assert [s for s, _, _ in steps.calls] == ["auth", "auth"]
    assert (
        run["status"] == "waiting"
        and run["items"][1]["status"] == "waiting_confirmation"
    )
    with pytest.raises(TrainError, match="not waiting"):
        drive(ctx, run["id"], "confirm", "auth")


def test_a_failed_gate_blocks_then_retry_or_rollback_the_chain(tmp_path: Path) -> None:
    steps, flags = Steps({("web", "./deploy.sh")}), []
    ctx = _context(tmp_path, steps, flags)
    run = drive(
        ctx, start(ctx, "staging", VERSIONS, services=["auth", "api", "web"])["id"]
    )
    assert run["status"] == "blocked"
    assert run["blocked"] == {
        "kind": "service",
        "name": "web",
        "step": "deploy",
        "detail": "exit code 1",
    }
    run = drive(ctx, run["id"], "retry")
    assert (
        run["status"] == "blocked" and [s for s, _, _ in steps.calls].count("web") == 2
    )
    run = drive(ctx, run["id"], "rollback", "auth")
    rolled = [(s, v["version"]) for s, k, v in steps.calls if k == "rollback"]
    assert rolled == [("web", "3.0.0"), ("api", "2.0.0"), ("auth", "1.0.0")]
    assert run["status"] == "rolled_back"
    assert {i["service"]: i["status"] for i in run["items"]} == {
        "auth": "rolled_back",
        "api": "rolled_back",
        "web": "rolled_back",
    }
    assert flags == []  # the flag never went on: web never shipped
    assert runs.metrics(tmp_path)[0]["rollbacksOk"] == 1


def test_a_failing_health_gate_counts_and_the_flag_goes_off_before_a_rollback(
    tmp_path: Path,
) -> None:
    steps, flags = Steps({("web", "./deploy.sh")}), []
    ctx = _context(tmp_path, steps, flags)
    run = drive(
        ctx, start(ctx, "staging", VERSIONS, services=["auth", "api", "web"])["id"]
    )
    ctx.step_runner = Steps()
    run = drive(ctx, run["id"], "retry")
    assert run["status"] == "done" and flags == [{"key": "checkout", "on": True}]

    failing = Steps({("auth", "url")})
    ctx = _context(tmp_path / "second", failing, flags)
    (tmp_path / "second").mkdir()
    run = drive(ctx, start(ctx, "staging", VERSIONS, services=["auth"])["id"])
    assert run["blocked"]["step"] == "health" and run["gateFailures"] == 1
    run = drive(ctx, run["id"], "abort")
    assert run["status"] == "aborted"


def test_an_express_deploy_ships_one_service_after_a_click(tmp_path: Path) -> None:
    steps = Steps()
    ctx = _context(tmp_path, steps)
    with pytest.raises(TrainError, match="exactly one"):
        start(ctx, "staging", VERSIONS, express=True)
    run = drive(
        ctx, start(ctx, "staging", VERSIONS, services=["web"], express=True)["id"]
    )
    assert run["status"] == "waiting" and steps.calls == []
    run = drive(ctx, run["id"], "confirm", "web")
    assert run["status"] == "done" and run["flags"] == []


def test_one_open_run_per_environment_and_a_lost_step_is_marked_interrupted(
    tmp_path: Path,
) -> None:
    ctx = _context(tmp_path, Steps())
    run = start(ctx, "production", VERSIONS, services=["auth"])
    with pytest.raises(TrainError, match="still open"):
        start(ctx, "production", VERSIONS)
    stored = runs.load(tmp_path, run["id"])
    stored["items"][0]["status"] = "deploying"
    runs.save(tmp_path, stored)
    (
        tmp_path / ".workpilot" / "release-train" / "runs" / f"{run['id']}.lock"
    ).write_text("999999999", encoding="utf-8")
    run = drive(ctx, run["id"])
    assert run["status"] == "blocked" and "interrupted" in run["items"][0]["detail"]


def test_the_view_names_the_problems(tmp_path: Path) -> None:
    text = TRAIN.replace("depends_on: [db]", "depends_on: [db, ghost]")
    ctx = Context(root=tmp_path, train=parse(text.encode()))
    page = view(ctx)
    assert page["order"]["waves"] == [["db"], ["auth"], ["api"], ["web"]]
    assert {
        "code": "unknown_dependency",
        "service": "auth",
        "dependency": "ghost",
    } in page["problems"]
    assert page["variables"] == ["UNLEASH_API_TOKEN"]


# --- the runner -----------------------------------------------------------------------


def _runner(project: Path, *args: str) -> tuple[int, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [
            sys.executable,
            str(BACKEND / "runners" / "release_coordinator_runner.py"),
            "--project-path",
            str(project),
            *args,
        ],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
        check=False,
    )
    return done.returncode, done.stdout


def test_the_runner_runs_nothing_without_the_approved_hash(tmp_path: Path) -> None:
    marker = tmp_path / "ran"
    (tmp_path / "release-train.yaml").write_text(
        "services:\n  - name: app\n    deploy: {command: [touch, ran]}\n",
        encoding="utf-8",
    )
    code, out = _runner(tmp_path, "--train")
    assert code == 0, out
    sha = json.loads(out.split("RELEASE_COORDINATOR_RESULT:", 1)[1])["sha256"]
    code, out = _runner(tmp_path, "--start", "staging", "--approved-hash", "0" * 64)
    assert code == 1 and "not_approved" in out and not marker.exists()
    code, out = _runner(tmp_path, "--start", "staging", "--approved-hash", sha)
    assert code == 0, out
    if sys.platform != "win32":
        assert marker.exists()

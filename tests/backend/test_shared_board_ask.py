"""Server mode: « Interroger le tableau » asked from the phone app.

A question starts the board-ask runner on the project's clone as a job; the
answer is kept for who asked, read back by its job id, and masked like any
job's output. Asking is the board's read right; another person's question,
or one of another project, is not found.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
# A key-shaped value the redaction masks; not a real key.
_FAKE_KEY = "sk-ant-api03-" + "A" * 24  # pragma: allowlist secret

_FAKE_RUNNER = """
import json, pathlib, sys, time
args = sys.argv[1:]
project = pathlib.Path(args[args.index("--project-dir") + 1])
question = next(a for a in args if a.startswith("--question="))[len("--question="):]
language = next(a for a in args if a.startswith("--language="))[len("--language="):]
history = json.loads(
    pathlib.Path(args[args.index("--history-file") + 1]).read_text(encoding="utf-8")
)
print("debug: starting", file=sys.stderr, flush=True)
if "slow" in question:
    time.sleep(30)
if "fail" in question:
    sys.exit(3)
if "silent" in question:
    print("nothing to say")
    sys.exit(0)
print("progress line")
print("__BOARD_ASK__:" + json.dumps({
    "answer": "You asked " + question + " in " + language + ", KEY",
    "matches": [{"taskId": "001-a", "title": "A", "state": "done"}],
    "mode": "ai",
    "searched": len(history),
    "seen": project.is_dir(),
}))
""".replace("KEY", _FAKE_KEY)


@pytest.fixture(autouse=True)
def events(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "ask.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.services import project_jobs
    from shared_board import ask

    sent: list[tuple[str, str, dict]] = []
    monkeypatch.setattr(project_jobs, "emit_board_event", lambda *a: sent.append(a))
    monkeypatch.setattr(project_jobs, "_jobs", None)
    monkeypatch.setattr(ask, "_results", type(ask._results)())
    backend = tmp_path / "backend"
    (backend / "runners").mkdir(parents=True)
    (backend / "runners" / "board_ask_runner.py").write_text(
        _FAKE_RUNNER, encoding="utf-8"
    )
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", backend)
    # Confinement is proven in test_run_isolation; here, what the job runs.
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    yield sent
    server_config.reset_settings_cache()


async def _project(tmp_path: Path, name: str = "clone"):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, User

    if db_engine._engine is None or name == "clone":
        db_engine._engine = None
        db_engine._session_factory = None
        await db_engine.init_db()
    clone = tmp_path / "repos" / name
    clone.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(clone)], check=True)
    async with db_engine.get_session_factory()() as db:
        org = Organization(name=name, slug=f"org-{name}")
        db.add(org)
        await db.flush()
        if name == "clone":
            for uid in ("u-1", "u-2"):
                db.add(User(id=uid, email=f"{uid}@x", display_name=uid))
        project = Project(
            org_id=org.id, name=name, repo_url="https://x/p.git", server_path=str(clone)
        )
        db.add(project)
        await db.commit()
        return project.id, org.id, clone


def _scope(project_id, org_id, clone, role="viewer"):
    from server.authz.scope import ProjectScope

    return ProjectScope(project_id, org_id, clone, role)


def _request(user="u-1"):
    from server.authz.principal import Principal
    from starlette.requests import Request

    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(id=user, email=f"{user}@x")
    return request


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


async def _settled(scope, job_id: str, user="u-1", timeout: float = 30.0):
    from shared_board import ask

    for _ in range(int(timeout * 10)):
        async with await _db() as db:
            answer = await ask.get_answer(
                job_id=job_id, request=_request(user), scope=scope, db=db
            )
        if answer["job"]["status"] in ("succeeded", "failed", "cancelled"):
            return answer
        await asyncio.sleep(0.1)
    raise AssertionError("no answer")


@pytest.mark.asyncio
async def test_a_question_is_answered_on_the_clone_for_who_asked(tmp_path, events):
    from fastapi import HTTPException
    from shared_board import ask
    from shared_board.ask import Question, Turn

    project_id, org_id, clone = await _project(tmp_path)
    scope = _scope(project_id, org_id, clone)
    asked = await ask.ask(
        body=Question(
            question="-la page d'admin ?",
            language="fr",
            history=[Turn(question="avant", answer="oui")],
        ),
        request=_request(),
        scope=scope,
    )
    assert asked["job"]["status"] == "queued"
    assert asked["job"]["feature"] == "board_ask"

    answer = await _settled(scope, asked["job"]["id"])
    assert answer["job"]["status"] == "succeeded"
    result = answer["result"]
    # The question that starts with a dash stayed the question; the runner
    # read the clone and the history file; what looks like a key is masked.
    assert result["answer"].startswith("You asked -la page d'admin ? in fr")
    assert _FAKE_KEY not in result["answer"]
    assert result["searched"] == 1 and result["seen"] is True
    assert result["matches"] == [{"taskId": "001-a", "title": "A", "state": "done"}]
    assert {e for _, e, _ in events} == {"feature_job"}

    # Somebody else's question is not found, nor one of another project.
    other_id, other_org, other_clone = await _project(tmp_path, "other")
    for request, where in (
        (_request("u-2"), scope),
        (_request(), _scope(other_id, other_org, other_clone)),
    ):
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await ask.get_answer(
                    job_id=asked["job"]["id"], request=request, scope=where, db=db
                )
        assert refused.value.status_code == 404
    async with await _db() as db:
        with pytest.raises(HTTPException) as missing:
            await ask.cancel(job_id="nope", request=_request(), scope=scope, db=db)
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_one_question_at_a_time_and_it_can_be_stopped(tmp_path):
    from fastapi import HTTPException
    from shared_board import ask
    from shared_board.ask import Question

    project_id, org_id, clone = await _project(tmp_path)
    scope = _scope(project_id, org_id, clone)
    slow = await ask.ask(
        body=Question(question="slow one"), request=_request(), scope=scope
    )
    with pytest.raises(HTTPException) as busy:
        await ask.ask(body=Question(question="again"), request=_request(), scope=scope)
    assert busy.value.status_code == 409
    # A teammate asks at the same time: their own question.
    theirs = await ask.ask(
        body=Question(question="silent"), request=_request("u-2"), scope=scope
    )

    async with await _db() as db:
        stopped = await ask.cancel(
            job_id=slow["job"]["id"], request=_request(), scope=scope, db=db
        )
    assert stopped == {"cancelled": True}
    cancelled = await _settled(scope, slow["job"]["id"])
    assert cancelled["job"]["status"] == "cancelled" and cancelled["result"] is None
    # A runner that printed no answer leaves none.
    silent = await _settled(scope, theirs["job"]["id"], user="u-2")
    assert silent["job"]["status"] == "succeeded" and silent["result"] is None


@pytest.mark.asyncio
async def test_a_failed_question_has_no_answer(tmp_path):
    from shared_board import ask
    from shared_board.ask import Question

    project_id, org_id, clone = await _project(tmp_path)
    scope = _scope(project_id, org_id, clone)
    asked = await ask.ask(
        body=Question(question="fail"), request=_request(), scope=scope
    )
    answer = await _settled(scope, asked["job"]["id"])
    assert answer["job"]["status"] == "failed" and answer["result"] is None


@pytest.mark.asyncio
async def test_a_question_the_server_cannot_run_is_refused(tmp_path, monkeypatch):
    from fastapi import HTTPException
    from server.services import project_jobs
    from shared_board import ask
    from shared_board.ask import Question

    project_id, org_id, clone = await _project(tmp_path)
    monkeypatch.setattr(project_jobs, "BACKEND_DIR", tmp_path / "nowhere")
    with pytest.raises(HTTPException) as refused:
        await ask.ask(
            body=Question(question="hi"),
            request=_request(),
            scope=_scope(project_id, org_id, clone),
        )
    assert refused.value.status_code == 409


@pytest.mark.asyncio
async def test_a_question_left_running_by_a_stopped_server_is_settled(tmp_path):
    from server.db.models import ProjectJob
    from shared_board import ask

    project_id, org_id, clone = await _project(tmp_path)
    async with await _db() as db:
        db.add(
            ProjectJob(
                id="job-1",
                project_id=project_id,
                feature="board_ask",
                started_by="u-1",
                status="running",
            )
        )
        await db.commit()
    async with await _db() as db:
        answer = await ask.get_answer(
            job_id="job-1",
            request=_request(),
            scope=_scope(project_id, org_id, clone),
            db=db,
        )
    assert answer["job"]["status"] == "failed" and answer["result"] is None


@pytest.mark.parametrize(
    "lines, expected",
    [
        (['__BOARD_ASK__:{"answer": "a"}'], {"answer": "a"}),
        (["__BOARD_ASK__:{not json"], None),
        (["__BOARD_ASK__:[1, 2]"], None),
        (["no marker"], None),
    ],
)
def test_the_answer_is_read_from_the_marker_line(lines, expected):
    from shared_board.ask import result_from

    assert result_from(["before", *lines]) == expected


def test_only_the_latest_answers_are_kept(monkeypatch):
    from shared_board import ask

    monkeypatch.setattr(ask, "KEPT_RESULTS", 2)
    for job in ("a", "b", "c"):
        asyncio.run(
            ask._keep_result(job, "succeeded", [f'__BOARD_ASK__:{{"answer": "{job}"}}'])
        )
    assert list(ask._results) == ["b", "c"]


def test_asking_the_board_is_its_read_right():
    from server.authz.mounting import permission_for

    assert permission_for("POST", "/api/board/ask", "task") == "task.read"
    assert (
        permission_for("POST", "/api/board/ask/jobs/{job_id}/cancel", "task")
        == "task.read"
    )
    assert permission_for("GET", "/api/board/ask/jobs/{job_id}", "task") == "task.read"


def test_a_question_carries_no_path_and_is_bounded():
    from pydantic import ValidationError
    from shared_board.ask import Question

    for body in (
        {"question": ""},
        {"question": "x" * 1001},
        {"question": "hi", "language": "../fr"},
        {"question": "hi", "project_dir": "/etc"},
        {"question": "hi", "history": [{"question": "q", "answer": "a"}] * 5},
    ):
        with pytest.raises(ValidationError):
            Question.model_validate(body)

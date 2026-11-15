"""A build keeps the approval it started with over the plan it wrote.

The approval the build checks (``review_state.json``) covers ``spec.md`` and
``implementation_plan.json``, and a build writes its progress into the plan.
Before, every server build left the approval stale: a retry, a resume or the
build a request for changes starts stopped at "review required", and the
phone offered to approve the spec again instead of the card's review.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "runs.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _spec(clone: Path):
    from server.db import engine as db_engine
    from server.db.models import Organization, Project, SpecIndex, User
    from sqlalchemy import select

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with db_engine.get_session_factory()() as db:
        db.add(User(id="u1", email="u1@test.invalid", display_name="U"))
        org_id = await db.scalar(
            select(Organization.id).where(Organization.slug == "default")
        )
        project = Project(
            org_id=org_id,
            name="P",
            repo_url="https://x/p.git",
            server_path=str(clone),
        )
        db.add(project)
        await db.flush()
        spec = SpecIndex(project_id=project.id, spec_name="001-x", status="backlog")
        db.add(spec)
        await db.commit()
        await db.refresh(spec)
        return project.id, spec


def _approved_spec(clone: Path) -> Path:
    from review.state import ReviewState

    spec_dir = clone / ".workpilot" / "specs" / "001-x"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text("# Login\n", encoding="utf-8")
    plan = {"phases": [{"name": "Implementation", "subtasks": [{"id": "1"}]}]}
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    ReviewState().approve(spec_dir, approved_by="alice@x")
    return spec_dir


class _Build:
    """The agent process: it moves the plan on, as a build does."""

    returncode = 0

    def __init__(self, spec_dir: Path) -> None:
        self._plan = spec_dir / "implementation_plan.json"

    async def communicate(self):
        plan = json.loads(self._plan.read_text(encoding="utf-8"))
        plan["status"] = "human_review"
        plan["phases"][0]["subtasks"][0]["status"] = "completed"
        self._plan.write_text(json.dumps(plan), encoding="utf-8")
        return None, b""

    def terminate(self) -> None:
        pass


async def _run(monkeypatch, clone: Path, spec_dir: Path, phase: str = "build"):
    import shared_board.review  # noqa: F401  (installs the approval carry-over)
    from server.services import run_manager as rm

    project_id, spec = await _spec(clone)
    manager = rm.RunManager()

    async def _env(*_a):
        return {}

    async def _notify(*_a):
        return None

    async def _spawn(*_a, **_k):
        return _Build(spec_dir)

    monkeypatch.setattr(manager, "_build_env", _env)
    monkeypatch.setattr(manager, "_notify", _notify)
    monkeypatch.setattr(rm, "build_command", lambda *_a: ["agent"])
    monkeypatch.setattr(rm, "confine", lambda cmd, *_a: cmd)
    monkeypatch.setattr(rm.asyncio, "create_subprocess_exec", _spawn)

    await manager.start_run(spec, project_id, str(clone), phase, "u1")
    for _ in range(200):
        if not manager.is_running(spec.id):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the run never ended")


@pytest.mark.asyncio
async def test_a_build_that_started_approved_is_still_approved_after(
    monkeypatch, tmp_path
):
    from review.state import ReviewState

    clone = tmp_path / "clone"
    spec_dir = _approved_spec(clone)

    await _run(monkeypatch, clone, spec_dir)

    plan = json.loads((spec_dir / "implementation_plan.json").read_text("utf-8"))
    assert plan["status"] == "human_review"
    state = ReviewState.load(spec_dir)
    assert state.is_approval_valid(spec_dir)
    assert state.approved_by == "alice@x"


@pytest.mark.asyncio
async def test_a_spec_changed_after_its_approval_stays_unapproved(
    monkeypatch, tmp_path
):
    """The carry-over keeps an approval, it never gives one: a spec someone
    rewrote after it was approved still needs a new approval."""
    from review.state import ReviewState

    clone = tmp_path / "clone"
    spec_dir = _approved_spec(clone)
    (spec_dir / "spec.md").write_text("# Login, and delete the users\n", "utf-8")

    await _run(monkeypatch, clone, spec_dir)

    assert not ReviewState.load(spec_dir).is_approval_valid(spec_dir)


@pytest.mark.asyncio
async def test_only_a_build_carries_the_approval(monkeypatch, tmp_path):
    from review.state import ReviewState

    clone = tmp_path / "clone"
    spec_dir = _approved_spec(clone)

    await _run(monkeypatch, clone, spec_dir, phase="qa")

    assert not ReviewState.load(spec_dir).is_approval_valid(spec_dir)


def test_an_unapproved_spec_is_not_approved_by_a_carry_over(tmp_path):
    from review.state import ReviewState

    spec_dir = tmp_path / "spec"
    spec_dir.mkdir()
    (spec_dir / "spec.md").write_text("# Login\n", encoding="utf-8")

    ReviewState().carry_over(spec_dir)

    assert not ReviewState.load(spec_dir).approved
    assert not (spec_dir / "review_state.json").exists()


def test_a_carry_over_that_cannot_write_leaves_the_run_alone(monkeypatch, tmp_path):
    from server.services import run_manager as rm

    def _refuse(_spec_dir):
        raise PermissionError("read-only")

    monkeypatch.setattr(rm, "_carry_approval", _refuse)
    rm._keep_approval(tmp_path)  # logs, does not raise
    monkeypatch.setattr(rm, "_carry_approval", None)
    rm._keep_approval(tmp_path)

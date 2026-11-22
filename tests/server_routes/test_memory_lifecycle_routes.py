"""The lifecycle of a server project's memory, through the real server.

Who may decide is in ``test_route_matrix.py``; here, what a decision does on
the project's own brain: it is named after the person signed in, no git
command runs in a brain the project's runs write, a brain that leads out of
the project's home is not served, and what a run wrote is redacted.
"""

from __future__ import annotations

import json
from pathlib import Path

from brain import Brain
from brain.lifecycle import journal
from brain.project_memory import ProjectMemory
from brain.tasks import project_name_from

from tests.server_routes.world import World

_FAKE_KEY = "sk-ant-api03-" + "B" * 24  # pragma: allowlist secret


def _brain(world: World, side: str = "a") -> tuple[Brain, ProjectMemory]:
    from server.services.run_isolation import project_brain

    root = project_brain(world.tmp / "repos", world.projects[side])
    brain = Brain(root)
    brain.init()
    memory = ProjectMemory(
        project=project_name_from(str(world.clone(side))), brain=brain
    )
    return brain, memory


def _gotcha(brain: Brain, memory: ProjectMemory, text: str) -> str:
    """Record *text* and answer its vault path, as the Memories tab knows it."""
    assert memory.record_gotcha(text)
    (note,) = (brain.root / memory.base / "gotchas").glob("*.md")
    return note.relative_to(brain.root).as_posix()


def _path(world: World, action: str) -> str:
    return f"/api/features/context/memory/{action}?project_id={world.projects['a']}"


async def _post(world: World, who: str, action: str, body: dict) -> dict:
    return await world.ok(who, "POST", _path(world, action), json=body)


async def _view(world: World, who: str = "viewer_a") -> dict:
    return await world.ok(who, "GET", _path(world, "lifecycle"))


async def test_no_brain_yet_is_said_not_failed(world):
    assert await _view(world) == {
        "success": False,
        "error": "no-brain",
        "code": "no-brain",
    }
    assert (await _post(world, "contributor_a", "pin", {"id": "x"}))[
        "code"
    ] == "no-brain"
    history = await world.ok("viewer_a", "GET", _path(world, "history") + "&id=x")
    assert history["code"] == "no-brain"


async def test_a_member_pins_forgets_restores_and_scopes_in_their_name(
    world, monkeypatch
):
    import brain.sync as brain_sync

    def no_git(*args, **kwargs):
        raise AssertionError("no git command runs in a server project's brain")

    brain, memory = _brain(world)
    rel = _gotcha(brain, memory, "Never push on Friday.")
    monkeypatch.setattr(brain_sync, "_git", no_git)

    got = await _post(world, "contributor_a", "pin", {"id": rel, "pinned": True})
    assert got["success"] and got["count"] == 1
    got = await _post(
        world, "contributor_a", "forget", {"id": rel, "reason": "We ship on Fridays."}
    )
    assert got["success"] and got["trash_id"].startswith("gotchas/")

    view = await _view(world)
    assert view["success"] and view["pinned"] == 0 and view["pin_limit"] == 50
    assert [item["id"] for item in view["trash"]] == [got["trash_id"]]
    assert view["conflicts"] == [] and view["maintainers"] == []
    assert view["can_arbitrate"] is False
    forget = view["journal"][0]
    assert forget["action"] == "forget" and forget["by"] == "contributor_a"
    assert forget["reason"] == "We ship on Fridays."
    assert "contributor_a@example.com" not in json.dumps(view)

    restored = await _post(world, "contributor_a", "restore", {"id": got["trash_id"]})
    assert restored["success"] and restored["path"] == rel
    scoped = await _post(
        world, "analyst_a", "scope", {"id": rel, "applies_to": "apps/web/"}
    )
    assert scoped == {"success": True, "applies_to": "apps/web/"}

    history = await world.ok("viewer_a", "GET", _path(world, "history") + f"&id={rel}")
    assert history["success"] and history["id"] == rel
    assert {e["action"] for e in history["entries"]} >= {"pin", "forget", "restore"}
    assert (await _view(world))["metrics"]["history_views"] == 1


async def test_an_agent_s_forget_is_undone_by_a_member(world):
    _, memory = _brain(world)
    memory.record_gotcha("The lockfile breaks the build.")
    memory.actor = "agent"
    assert memory.forget("gotcha", "the-lockfile-breaks-the-build")

    view = await _view(world)
    assert view["last_undo"] and view["revertible"][view["last_undo"]] == "undo"
    got = await _post(world, "contributor_a", "revert", {"entry_id": view["last_undo"]})
    assert got["success"] and got["mode"] == "undo" and got["restored"]
    again = await _post(
        world, "contributor_a", "revert", {"entry_id": view["last_undo"]}
    )
    assert again["success"] is False and again["code"] == "not-revertible"


async def test_hostile_ids_are_refused_before_a_file_is_opened(world):
    _, memory = _brain(world)
    memory.record_gotcha("Keep it.")
    for bad in ("../../../etc/passwd.md", "/etc/passwd", "gotchas/.hidden.md", ""):
        got = await _post(world, "contributor_a", "forget", {"id": bad})
        assert got["code"] == "invalid", bad
        got = await _post(world, "contributor_a", "restore", {"id": bad})
        assert got["code"] in {"invalid", "not-found"}, bad
    history = await world.ok(
        "viewer_a", "GET", _path(world, "history") + "&id=../../x.md"
    )
    assert history["code"] == "invalid"
    # An entry id is twelve hex characters, checked by the body's model.
    answer = await world.call(
        "contributor_a", "POST", _path(world, "revert"), json={"entry_id": "../x"}
    )
    assert answer.status_code == 422


async def test_a_viewer_reads_and_decides_nothing(world):
    brain, memory = _brain(world)
    rel = _gotcha(brain, memory, "Read me.")
    assert (await _view(world, "viewer_a"))["success"]
    answer = await world.call(
        "viewer_a", "POST", _path(world, "pin"), json={"id": rel, "pinned": True}
    )
    assert answer.status_code == 403
    assert "insight.write" in answer.text


async def test_a_brain_that_leads_out_of_the_project_s_home_is_not_served(world):
    from server.services.run_isolation import project_brain

    other, memory = _brain(world, "b")
    memory.record_gotcha("Globex's secret plan.")
    mine = project_brain(world.tmp / "repos", world.projects["a"])
    mine.parent.mkdir(parents=True, exist_ok=True)
    mine.symlink_to(other.root, target_is_directory=True)

    assert (await _view(world))["code"] == "no-brain"
    assert Path(other.root).is_dir()


async def test_what_a_run_wrote_is_redacted_when_served(world):
    brain, memory = _brain(world)
    rel = _gotcha(brain, memory, "Rotate the key.")
    journal.append(
        brain.root,
        memory.base,
        journal.JournalEntry(action="update", actor="agent", note=rel),
    )
    # A run writes its brain as it likes, the journal too.
    folder = journal.journal_dir(brain.root, memory.base)
    month = sorted(folder.glob("*.md"))[-1]
    text = month.read_text(encoding="utf-8")
    month.write_text(text.replace('"reason": ""', f'"reason": "{_FAKE_KEY}"'), "utf-8")

    view = await _view(world)
    assert view["success"]
    (update,) = [e for e in view["journal"] if e["action"] == "update"]
    assert update["reason"] and _FAKE_KEY not in update["reason"]
    assert _FAKE_KEY not in json.dumps(view)

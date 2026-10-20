"""An invalid model-generated plan must never overwrite the existing document."""

import json

import pytest
from core.runtimes.tool_executor import ToolExecutor


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["write_file", "Write"])
async def test_invalid_plan_preserves_previous_file(tmp_path, tool):
    target = tmp_path / "implementation_plan.json"
    target.write_text('{"feature":"existing"}', encoding="utf-8")
    executor = ToolExecutor(str(tmp_path))
    with pytest.raises(ValueError, match="existing file was not changed"):
        await executor.execute(
            tool,
            {
                "path": str(target),
                "content": '{"rerunNote": "Phase "planning" re-run"}',
            },
        )
    assert json.loads(target.read_text(encoding="utf-8")) == {"feature": "existing"}


@pytest.mark.asyncio
async def test_valid_plan_with_quoted_note_is_written(tmp_path):
    executor = ToolExecutor(str(tmp_path))
    plan = {"feature": "Ajout de namespace", "rerunNote": 'Phase "planning" re-run'}
    await executor.execute(
        "write_file", {"path": "implementation_plan.json", "content": json.dumps(plan)}
    )
    assert (
        json.loads((tmp_path / "implementation_plan.json").read_text(encoding="utf-8"))
        == plan
    )


# --------------------------------------------------------------------------- #
# The plan the executor used to refuse and lose
# --------------------------------------------------------------------------- #
#
# A local model hands back its JSON inside a ```json fence, or with a sentence
# in front of it, far more often than it gets the bare document right. The whole
# content was dropped: no file existed for `auto_fix_plan` to repair, and the
# plan was in the tool call rather than in the response text, so `recover_plan`
# had nothing to read either. Three planning sessions were then spent on a plan
# WorkPilot had been handed and thrown away.

PLAN = {
    "feature": "Ajout de namespaces manquants",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "phase-1",
            "name": "Implementation",
            "subtasks": [{"id": "subtask-1-1", "description": "Add namespace"}],
        }
    ],
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wrapper",
    [
        "```json\n{body}\n```",
        "```\n{body}\n```",
        "Here is the implementation plan:\n{body}",
        "{body}\n\nThat covers every requirement.",
        "Voici le plan :\n```json\n{body}\n```\nJ'ai terminé.",
    ],
)
async def test_a_wrapped_plan_is_written_not_refused(tmp_path, wrapper):
    executor = ToolExecutor(str(tmp_path))
    await executor.execute(
        "Write",
        {
            "file_path": "implementation_plan.json",
            "content": wrapper.format(body=json.dumps(PLAN)),
        },
    )
    written = json.loads(
        (tmp_path / "implementation_plan.json").read_text(encoding="utf-8")
    )
    assert written == PLAN


@pytest.mark.asyncio
async def test_a_bare_phases_array_is_written_for_the_reshaper(tmp_path):
    """Not an object, and still the only copy of the plan. The validator now
    reports a non-object instead of crashing, and auto-fix reshapes it."""
    executor = ToolExecutor(str(tmp_path))
    await executor.execute(
        "write_file",
        {"path": "implementation_plan.json", "content": json.dumps(PLAN["phases"])},
    )
    assert (
        json.loads((tmp_path / "implementation_plan.json").read_text(encoding="utf-8"))
        == PLAN["phases"]
    )


@pytest.mark.asyncio
async def test_content_with_no_json_at_all_is_still_refused(tmp_path):
    """The model narrating the plan instead of writing it stays an error, fed
    back so it can correct itself in the same session."""
    target = tmp_path / "implementation_plan.json"
    target.write_text('{"feature":"existing"}', encoding="utf-8")
    executor = ToolExecutor(str(tmp_path))
    with pytest.raises(ValueError, match="existing file was not changed"):
        await executor.execute(
            "Write",
            {
                "file_path": str(target),
                "content": "I will now create the implementation plan.",
            },
        )
    assert json.loads(target.read_text(encoding="utf-8")) == {"feature": "existing"}


@pytest.mark.asyncio
async def test_a_salvaged_plan_reaches_the_validator(tmp_path):
    """End to end: the fenced write the build used to fail on now validates."""
    from spec.validate_pkg import SpecValidator, auto_fix_plan

    executor = ToolExecutor(str(tmp_path))
    await executor.execute(
        "Write",
        {
            "file_path": "implementation_plan.json",
            "content": "```json\n" + json.dumps(PLAN) + "\n```",
        },
    )
    auto_fix_plan(tmp_path)
    result = SpecValidator(tmp_path).validate_implementation_plan()
    assert result.valid, result.errors


@pytest.mark.asyncio
async def test_the_watermark_ledger_records_what_it_stripped(tmp_path):
    """The cleaning already happened on this path; the record did not, because
    no client passed a spec directory down to the executor."""
    spec_dir = tmp_path / "spec"
    spec_dir.mkdir()
    executor = ToolExecutor(str(tmp_path), spec_dir=str(spec_dir))
    await executor.execute("Write", {"file_path": "Foo.cs", "content": "class​ Foo {}"})
    assert (tmp_path / "Foo.cs").read_text(encoding="utf-8") == "class Foo {}"
    ledger = spec_dir / "watermarks.jsonl"
    assert ledger.exists()
    assert "U+200B" in ledger.read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_the_plan_cannot_be_blanked(tmp_path):
    """`EmptyFile` on the plan is never what a planner means, and the existing
    plan is the thing that would be lost."""
    target = tmp_path / "implementation_plan.json"
    target.write_text(json.dumps(PLAN), encoding="utf-8")
    executor = ToolExecutor(str(tmp_path))
    with pytest.raises(ValueError, match="cannot be written empty"):
        await executor.execute(
            "Write", {"file_path": "implementation_plan.json", "EmptyFile": True}
        )
    assert json.loads(target.read_text(encoding="utf-8")) == PLAN

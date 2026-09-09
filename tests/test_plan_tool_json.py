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

#!/usr/bin/env python3
"""
E2E Validation of the Memory Chain
==================================

Validates the full production memory path used by the kanban pipeline:

    save_session_memory() -> ProjectMemory -> the shared Obsidian vault
    get_memory_context()  -> ProjectMemory -> retrieved context

This file used to validate the same chain through Graphiti / LadybugDB, with a
stub Ollama server standing in for the embedder and the LLM. The vault is the
one memory now (`brain/project_memory.py`): nothing in the chain talks to
Graphiti, needs an embedding or a model, or needs a stub — so the check runs on
every platform, with nothing installed beyond git.

Usage:
    cd apps/backend
    python integrations/graphiti/test_e2e_stub_memory.py
"""

import asyncio
import os
import sys
import tempfile
from pathlib import Path

# Add backend root to path (same pattern as sibling test scripts)
backend_dir = Path(__file__).parent.parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))


async def run_validation(work_dir: Path) -> int:
    project_dir = work_dir / "project"
    spec_dir = project_dir / "specs" / "001-e2e-validation"
    spec_dir.mkdir(parents=True)
    os.environ["WORKPILOT_BRAIN_DIR"] = str(work_dir / "brain")
    os.environ.pop("BRAIN_ENABLED", None)

    from agents.memory_manager import get_memory_context, save_session_memory
    from memory.store import get_project_memory

    failures = 0

    # 1. Save session memory through the production entry point
    discoveries = {
        "files_understood": {
            "src/api/auth.py": "JWT authentication handler with refresh tokens"
        },
        "patterns_found": ["Always validate JWT expiry before refreshing tokens"],
        "gotchas_encountered": [
            "Token refresh endpoint requires the legacy session cookie"
        ],
    }
    saved, storage = await save_session_memory(
        spec_dir,
        project_dir,
        subtask_id="subtask-1",
        session_num=1,
        success=True,
        subtasks_completed=["subtask-1"],
        discoveries=discoveries,
    )
    print(f"save_session_memory -> saved={saved}, storage={storage}")
    if not saved or storage != "brain":
        print("FAIL: insights were not persisted to the shared brain")
        failures += 1

    # 2. Pattern and gotcha round-trip (the learning-loop episode types)
    memory = get_project_memory(spec_dir, project_dir)
    if memory is None:
        print("FAIL: project memory unavailable")
        failures += 1
    else:
        try:
            pattern_ok = await memory.save_pattern(
                "Always validate JWT expiry before refreshing tokens"
            )
            gotcha_ok = await memory.save_gotcha(
                "Token refresh endpoint requires the legacy session cookie"
            )
            patterns, gotchas = await memory.get_patterns_and_gotchas(
                "JWT authentication token refresh", num_results=3, min_score=0.3
            )
            print(
                f"save_pattern={pattern_ok}, save_gotcha={gotcha_ok}, "
                f"retrieved {len(patterns)} pattern(s), {len(gotchas)} gotcha(s)"
            )
            if not (pattern_ok and gotcha_ok and patterns and gotchas):
                print("FAIL: pattern/gotcha round-trip failed")
                failures += 1
        finally:
            await memory.close()

    # 3. Retrieve context for a related subtask (production retrieval path)
    context = await get_memory_context(
        spec_dir,
        project_dir,
        subtask={
            "id": "subtask-2",
            "description": "Improve JWT authentication token refresh handling",
        },
    )
    print(
        f"get_memory_context -> {'<none>' if context is None else f'{len(context)} chars'}"
    )
    if context:
        print("--- context preview ---")
        print("\n".join(context.splitlines()[:20]))
        print("-----------------------")
    if not context or "Session 1" not in context:
        print("FAIL: no usable context retrieved from the shared brain")
        failures += 1

    # 4. The vault holds it, as Obsidian notes a person can open
    notes = sorted((work_dir / "brain" / "knowledge" / "projects").rglob("*.md"))
    print(f"vault notes -> {len(notes)}")
    if not any("gotchas" in n.parts for n in notes):
        print("FAIL: the gotcha is not a note in the vault")
        failures += 1

    return failures


def _run() -> int:
    with tempfile.TemporaryDirectory(prefix="memory_e2e_") as tmp:
        return asyncio.run(run_validation(Path(tmp)))


def test_memory_chain_through_the_vault(monkeypatch):
    """
    Pytest entry point: save + retrieval through the production memory chain,
    end to end, on every platform. Marked `stubbed_e2e` so the directory-wide
    external-service skip in conftest.py does not apply to it.
    """
    # run_validation points WORKPILOT_BRAIN_DIR at its temporary vault;
    # monkeypatch restores the environment afterwards.
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", "")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    failures = _run()
    assert failures == 0, f"{failures} memory-chain check(s) failed"


# Mark applied at module import so conftest can detect and exempt this test.
test_memory_chain_through_the_vault.stubbed_e2e = True


def main() -> int:
    failures = _run()
    if failures:
        print(f"\nE2E validation FAILED ({failures} check(s) failed)")
        return 1
    print("\nE2E validation PASSED: save + retrieval both went through the vault")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""The prompt optimizer runner the Electron service spawns.

It did not exist: the dialog could only ever answer "prompt_optimizer_runner.py
not found". What is pinned here is the protocol the service parses — status
codes, JSON-encoded deltas, one result line, a coded error — and the lenient
reading of a model's answer, since an answer that ignored the tags is still a
rewrite worth showing.
"""

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

RUNNER = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "backend"
    / "runners"
    / "prompt_optimizer_runner.py"
)


@pytest.fixture
def runner():
    spec = importlib.util.spec_from_file_location("prompt_optimizer_undertest", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def drive(runner, monkeypatch, capsys, argv, chunks=(), error=None):
    seen = {}

    async def fake_completion(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["kwargs"] = kwargs
        if error is not None:
            kwargs["on_error"](error)
            return ""
        for chunk in chunks:
            kwargs["on_delta"](chunk)
        return "".join(chunks)

    fake = types.ModuleType("core.oneshot")
    fake.oneshot_completion = fake_completion
    monkeypatch.setitem(sys.modules, "core.oneshot", fake)

    code = runner.main(argv)
    return code, capsys.readouterr().out, seen


def lines_with(out, marker):
    return [line[len(marker) :] for line in out.splitlines() if line.startswith(marker)]


TAGGED = (
    "<optimized_prompt>\nAjoute un endpoint GET /api/users.\n</optimized_prompt>\n"
    "<changes>\n- Précisé la route\n- Ajouté des critères\n</changes>\n"
    "<reasoning>\nPlus précis.\n</reasoning>"
)


def test_a_tagged_answer_becomes_one_result_line(runner, monkeypatch, capsys, tmp_path):
    code, out, seen = drive(
        runner,
        monkeypatch,
        capsys,
        [
            "--project-dir",
            str(tmp_path),
            "--prompt",
            "ajoute users",
            "--agent-type",
            "coding",
        ],
        chunks=[TAGGED[:40], TAGGED[40:]],
    )

    assert code == 0
    assert lines_with(out, runner.STATUS_MARKER) == ["context", "generating", "parsing"]
    assert (
        "".join(json.loads(d) for d in lines_with(out, runner.DELTA_MARKER)) == TAGGED
    )
    (result_line,) = lines_with(out, runner.RESULT_MARKER)
    assert json.loads(result_line) == {
        "optimized": "Ajoute un endpoint GET /api/users.",
        "changes": ["Précisé la route", "Ajouté des critères"],
        "reasoning": "Plus précis.",
    }
    assert "ajoute users" in seen["prompt"]
    assert "coding" in seen["prompt"]


def test_the_prompt_can_come_from_a_file(runner, monkeypatch, capsys, tmp_path):
    prompt_file = tmp_path / "prompt.txt"
    prompt_file.write_text(
        'un prompt très long\navec des "guillemets"', encoding="utf-8"
    )

    code, _, seen = drive(
        runner,
        monkeypatch,
        capsys,
        ["--project-dir", str(tmp_path), "--prompt-file", str(prompt_file)],
        chunks=[TAGGED],
    )

    assert code == 0
    assert 'avec des "guillemets"' in seen["prompt"]


def test_a_provider_failure_is_a_coded_error(runner, monkeypatch, capsys, tmp_path):
    code, out, _ = drive(
        runner,
        monkeypatch,
        capsys,
        ["--project-dir", str(tmp_path), "--prompt", "x"],
        error={"message": "Invalid API key", "code": "auth"},
    )

    assert code == 1
    (error_line,) = lines_with(out, runner.ERROR_MARKER)
    assert json.loads(error_line) == {"message": "Invalid API key", "code": "auth"}
    assert not lines_with(out, runner.RESULT_MARKER)


def test_a_missing_project_is_refused_before_any_call(
    runner, monkeypatch, capsys, tmp_path
):
    code, out, seen = drive(
        runner,
        monkeypatch,
        capsys,
        ["--project-dir", str(tmp_path / "nope"), "--prompt", "x"],
    )

    assert code == 1
    assert (
        json.loads(lines_with(out, runner.ERROR_MARKER)[0])["code"]
        == "project_not_found"
    )
    assert "prompt" not in seen


def test_an_untagged_answer_is_still_a_rewrite(runner):
    assert runner.parse_response("Just a better prompt.") == {
        "optimized": "Just a better prompt.",
        "changes": [],
        "reasoning": "",
    }


def test_a_json_answer_is_read(runner):
    answer = '```json\n{"optimized": "P", "changes": ["a"], "reasoning": "r"}\n```'
    assert runner.parse_response(answer) == {
        "optimized": "P",
        "changes": ["a"],
        "reasoning": "r",
    }


def test_an_unclosed_section_stops_at_the_next_tag(runner):
    answer = "<optimized_prompt>\nP\n<changes>\n- a\n</changes>"
    assert runner.parse_response(answer) == {
        "optimized": "P",
        "changes": ["a"],
        "reasoning": "",
    }


def test_an_empty_answer_is_none(runner):
    assert runner.parse_response("   ") is None


def test_context_reads_the_project_without_walking_it(runner, tmp_path):
    (tmp_path / "Api.sln").write_text("", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text(
        "# Rules\nClean architecture.", encoding="utf-8"
    )
    (tmp_path / "src").mkdir()
    (tmp_path / "node_modules").mkdir()

    context = runner.gather_project_context(tmp_path)

    assert ".NET (solution)" in context
    assert "Clean architecture." in context
    assert "src/" in context
    assert "node_modules" not in context


def test_context_is_bounded(runner, tmp_path):
    (tmp_path / "README.md").write_text("x" * 50_000, encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text("y" * 50_000, encoding="utf-8")

    assert len(runner.gather_project_context(tmp_path)) <= runner.CONTEXT_BUDGET + 5

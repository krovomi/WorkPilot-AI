"""The runner behind the "Traduction inter-langages" page.

It could not work: the page looked for it outside the repository, the Claude
call used a client method that does not exist, and the "fallback" returned the
source commented out as if it were a translation. What is pinned here is the
protocol the Electron handler parses (JSON deltas, one result line, a coded
error), the provider-agnostic call, and the reading of the model's answer.
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
    / "cross_language_translation_runner.py"
)


@pytest.fixture
def runner():
    spec = importlib.util.spec_from_file_location("cross_lang_undertest", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.py"
    path.write_text("def add(a, b):\n    # sum\n    return a + b\n", encoding="utf-8")
    return path


def drive(runner, monkeypatch, capsys, argv, chunks=(), error=None, raises=None):
    seen = {}

    async def fake_completion(prompt, **kwargs):
        seen["prompt"] = prompt
        seen["kwargs"] = kwargs
        if raises is not None:
            raise raises
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


def base_args(source, *extra):
    return [
        "--source-lang",
        "python",
        "--target-lang",
        "typescript",
        "--file",
        str(source),
        "--project",
        str(source.parent),
        *extra,
    ]


ANSWER = "```typescript\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n```"


def test_a_translation_streams_then_ends_with_one_result(
    runner, monkeypatch, capsys, source
):
    code, out, seen = drive(
        runner,
        monkeypatch,
        capsys,
        base_args(source),
        chunks=[ANSWER[:20], ANSWER[20:]],
    )

    assert code == 0
    deltas = [json.loads(d) for d in lines_with(out, runner.DELTA_MARKER)]
    assert "".join(deltas) == ANSWER
    [result] = [json.loads(r) for r in lines_with(out, runner.RESULT_MARKER)]
    assert result["translated_code"].startswith("export function add")
    assert "```" not in result["translated_code"]
    assert result["test_code"] is None
    assert result["lines_translated"] == 3
    # Every stdout line is a marker: nothing else for the handler to misread.
    assert all(line.startswith("__") for line in out.splitlines())
    # The page's provider, not a hardcoded Claude model.
    assert seen["kwargs"]["model"] is None
    assert seen["kwargs"]["system_prompt"] == runner.SYSTEM_PROMPT


def test_the_prompt_carries_the_source_as_data(runner, monkeypatch, capsys, source):
    _, _, seen = drive(
        runner,
        monkeypatch,
        capsys,
        base_args(source, "--preserve-comments"),
        chunks=[ANSWER],
    )
    prompt = seen["prompt"]
    assert "Translate this Python code to TypeScript" in prompt
    assert '<source_code language="Python">' in prompt
    assert "return a + b" in prompt
    assert "Keep every comment" in prompt
    assert runner.TEST_MARKER not in prompt


def test_tests_are_split_from_the_translation(runner, monkeypatch, capsys, source):
    answer = (
        ANSWER
        + "\n\n```typescript\n// TEST FILE\nimport { add } from './add';\n"
        + "test('add', () => expect(add(1, 2)).toBe(3));\n```"
    )
    code, out, seen = drive(
        runner,
        monkeypatch,
        capsys,
        base_args(source, "--generate-tests"),
        chunks=[answer],
    )
    assert code == 0
    assert runner.TEST_MARKER in seen["prompt"]
    [result] = [json.loads(r) for r in lines_with(out, runner.RESULT_MARKER)]
    assert result["translated_code"].startswith("export function add")
    assert result["test_code"].startswith("// TEST FILE")


def test_no_output_file_unless_asked(runner, monkeypatch, capsys, source, tmp_path):
    before = set(tmp_path.iterdir())
    drive(runner, monkeypatch, capsys, base_args(source), chunks=[ANSWER])
    assert set(tmp_path.iterdir()) == before

    target = tmp_path / "out" / "add.ts"
    code, out, _ = drive(
        runner,
        monkeypatch,
        capsys,
        base_args(source, "--output", str(target)),
        chunks=[ANSWER],
    )
    assert code == 0
    assert target.read_text(encoding="utf-8").startswith("export function add")
    [result] = [json.loads(r) for r in lines_with(out, runner.RESULT_MARKER)]
    assert result["output_file"] == str(target)


def test_a_provider_failure_is_reported_not_faked(runner, monkeypatch, capsys, source):
    code, out, _ = drive(
        runner,
        monkeypatch,
        capsys,
        base_args(source),
        error={"message": "Not signed in", "code": "auth_required"},
    )
    assert code == 1
    assert lines_with(out, runner.RESULT_MARKER) == []
    [error] = [json.loads(e) for e in lines_with(out, runner.ERROR_MARKER)]
    assert error == {"message": "Not signed in", "code": "auth_required"}


def test_an_exception_becomes_a_coded_error(runner, monkeypatch, capsys, source):
    code, out, _ = drive(
        runner, monkeypatch, capsys, base_args(source), raises=RuntimeError("boom")
    )
    assert code == 1
    [error] = [json.loads(e) for e in lines_with(out, runner.ERROR_MARKER)]
    assert error["code"] == "provider_error"
    assert "boom" in error["message"]


@pytest.mark.parametrize(
    ("argv_patch", "expected"),
    [
        ({"--target-lang": "python"}, "same_language"),
        ({"--target-lang": "cobol"}, "unsupported_language"),
    ],
)
def test_invalid_languages_never_reach_the_model(
    runner, monkeypatch, capsys, source, argv_patch, expected
):
    argv = base_args(source)
    for flag, value in argv_patch.items():
        argv[argv.index(flag) + 1] = value
    code, out, seen = drive(runner, monkeypatch, capsys, argv, chunks=[ANSWER])
    assert code == 1
    assert "prompt" not in seen
    [error] = [json.loads(e) for e in lines_with(out, runner.ERROR_MARKER)]
    assert error["code"] == expected


def test_empty_source_never_reaches_the_model(runner, monkeypatch, capsys, tmp_path):
    empty = tmp_path / "empty.py"
    empty.write_text("   \n", encoding="utf-8")
    code, out, seen = drive(runner, monkeypatch, capsys, base_args(empty))
    assert code == 1
    assert "prompt" not in seen
    assert json.loads(lines_with(out, runner.ERROR_MARKER)[0])["code"] == "empty_source"


def test_extract_reads_unfenced_and_reordered_answers(runner):
    assert runner.extract_code_blocks("let x = 1;") == {
        "translated_code": "let x = 1;",
        "test_code": None,
    }
    reordered = "```ts\n// TEST FILE\nit()\n```\n```ts\nconst a = 1;\n```"
    assert runner.extract_code_blocks(reordered) == {
        "translated_code": "const a = 1;",
        "test_code": "// TEST FILE\nit()",
    }
    csharp = "```c#\npublic class A {}\n```"
    assert runner.extract_code_blocks(csharp)["translated_code"] == "public class A {}"

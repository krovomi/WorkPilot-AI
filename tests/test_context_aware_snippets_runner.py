"""The context-aware snippets runner the Electron service spawns.

It never worked: it imported three modules that do not exist, so every run
answered "under development", and the project context it would have sent was a
hard-coded list. What is pinned here is the protocol the service parses —
status codes, JSON-encoded deltas, one result line, a coded error — the lenient
reading of a model's answer (a JSON object in a fence or in prose, else a fenced
code block), and the project context: read from the project, bounded, and never
carrying a file the secret scanner flags.
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
    / "context_aware_snippets_runner.py"
)


@pytest.fixture
def runner(monkeypatch):
    spec = importlib.util.spec_from_file_location("snippets_undertest", RUNNER)
    module = importlib.util.module_from_spec(spec)
    # Registered first: a dataclass resolves its annotations through sys.modules.
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


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


ANSWER = json.dumps(
    {
        "snippet": "export function isEmail(value: string): boolean {\n  return /@/.test(value);\n}",
        "language": "TypeScript",
        "description": "Valide une adresse e-mail.",
        "adaptations": ["Export nommé, comme le reste du projet"],
        "reasoning": "Le projet n'exporte jamais par défaut.",
        "context_used": ["made up by the model"],
    },
    ensure_ascii=False,
)


def args(project_dir, *extra, snippet_type="function", description="valider un email"):
    return [
        "--project-dir",
        str(project_dir),
        "--snippet-type",
        snippet_type,
        "--description",
        description,
        *extra,
    ]


def test_a_json_answer_becomes_one_result_line(runner, monkeypatch, capsys, tmp_path):
    (tmp_path / "AGENTS.md").write_text("# Rules\nNamed exports.", encoding="utf-8")

    code, out, seen = drive(
        runner,
        monkeypatch,
        capsys,
        args(tmp_path, "--language", "typescript"),
        chunks=[ANSWER[:30], ANSWER[30:]],
    )

    assert code == 0
    assert lines_with(out, runner.STATUS_MARKER) == ["context", "generating", "parsing"]
    assert (
        "".join(json.loads(d) for d in lines_with(out, runner.DELTA_MARKER)) == ANSWER
    )
    (result_line,) = lines_with(out, runner.RESULT_MARKER)
    result = json.loads(result_line)
    assert result["snippet"].startswith("export function isEmail")
    assert result["language"] == "typescript"
    assert result["description"] == "Valide une adresse e-mail."
    assert result["adaptations"] == ["Export nommé, comme le reste du projet"]
    assert result["reasoning"] == "Le projet n'exporte jamais par défaut."
    # What was read, not what the model claims it read.
    assert result["context_used"] == ["AGENTS.md"]
    assert "valider un email" in seen["prompt"]
    assert "Named exports." in seen["prompt"]
    assert "typescript (chosen by the user)" in seen["prompt"]
    assert seen["kwargs"]["max_turns"] == 1
    assert seen["kwargs"]["project_dir"] == str(tmp_path)


def test_the_description_can_come_from_a_file(runner, monkeypatch, capsys, tmp_path):
    description = tmp_path / "description.txt"
    description.write_text('- une liste\navec des "guillemets"', encoding="utf-8")

    code, _, seen = drive(
        runner,
        monkeypatch,
        capsys,
        [
            "--project-dir",
            str(tmp_path),
            "--snippet-type",
            "hook",
            "--description-file",
            str(description),
        ],
        chunks=[ANSWER],
    )

    assert code == 0
    assert 'avec des "guillemets"' in seen["prompt"]
    assert "Snippet type: hook" in seen["prompt"]


def test_the_model_is_passed_through(runner, monkeypatch, capsys, tmp_path):
    _, _, seen = drive(
        runner,
        monkeypatch,
        capsys,
        args(tmp_path, "--model", "some-model"),
        chunks=[ANSWER],
    )
    assert seen["kwargs"]["model"] == "some-model"


def test_a_provider_failure_is_a_coded_error(runner, monkeypatch, capsys, tmp_path):
    code, out, _ = drive(
        runner,
        monkeypatch,
        capsys,
        args(tmp_path),
        error={"message": "Invalid API key", "code": "auth"},
    )

    assert code == 1
    (error_line,) = lines_with(out, runner.ERROR_MARKER)
    assert json.loads(error_line) == {"message": "Invalid API key", "code": "auth"}
    assert not lines_with(out, runner.RESULT_MARKER)


def test_an_exception_is_a_provider_error(runner, monkeypatch, capsys, tmp_path):
    code, out, _ = drive(
        runner, monkeypatch, capsys, args(tmp_path), raises=RuntimeError("boom")
    )

    assert code == 1
    error = json.loads(lines_with(out, runner.ERROR_MARKER)[0])
    assert error["code"] == "provider_error"
    assert "boom" in error["message"]


def test_an_unreadable_answer_is_an_invalid_response(
    runner, monkeypatch, capsys, tmp_path
):
    code, out, _ = drive(
        runner, monkeypatch, capsys, args(tmp_path), chunks=['{"snippet": "broken']
    )

    assert code == 1
    assert (
        json.loads(lines_with(out, runner.ERROR_MARKER)[0])["code"]
        == "invalid_response"
    )
    assert not lines_with(out, runner.RESULT_MARKER)


def test_a_missing_project_is_refused_before_any_call(
    runner, monkeypatch, capsys, tmp_path
):
    code, out, seen = drive(runner, monkeypatch, capsys, args(tmp_path / "nope"))

    assert code == 1
    assert (
        json.loads(lines_with(out, runner.ERROR_MARKER)[0])["code"]
        == "project_not_found"
    )
    assert "prompt" not in seen


def test_an_empty_description_is_refused_before_any_call(
    runner, monkeypatch, capsys, tmp_path
):
    code, out, seen = drive(
        runner, monkeypatch, capsys, args(tmp_path, description="   ")
    )

    assert code == 1
    assert (
        json.loads(lines_with(out, runner.ERROR_MARKER)[0])["code"]
        == "empty_description"
    )
    assert "prompt" not in seen


def test_an_unknown_snippet_type_is_refused(runner, tmp_path):
    with pytest.raises(SystemExit):
        runner.main(args(tmp_path, snippet_type="widget"))


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse(runner, text):
    return runner.parse_response(text, language="python", description="desc")


def test_a_fenced_json_answer_is_read(runner):
    answer = '```json\n{"snippet": "def f():\\n    pass", "adaptations": ["a"]}\n```'
    assert parse(runner, answer) == {
        "snippet": "def f():\n    pass",
        "language": "python",
        "description": "desc",
        "adaptations": ["a"],
        "reasoning": "",
    }


def test_json_wrapped_in_prose_is_read(runner):
    answer = 'Here is the snippet:\n{"snippet": "x = {1: 2}", "language": "py"}\nEnjoy.'
    result = parse(runner, answer)
    assert result["snippet"] == "x = {1: 2}"
    assert result["language"] == "python"


def test_a_fence_inside_the_snippet_string_is_removed(runner):
    answer = json.dumps({"snippet": "```ts\nconst a = 1;\n```"})
    assert parse(runner, answer)["snippet"] == "const a = 1;"


def test_a_fenced_code_block_is_the_fallback(runner):
    answer = "Voici le code :\n\n```tsx\nexport const A = () => null;\n```\n"
    result = parse(runner, answer)
    assert result["snippet"] == "export const A = () => null;"
    assert result["language"] == "typescript"
    assert result["description"] == "desc"


def test_bare_code_is_still_a_snippet(runner):
    assert (
        parse(runner, "def f():\n    return 1")["snippet"] == "def f():\n    return 1"
    )


def test_a_json_object_without_a_snippet_is_not_one(runner):
    assert parse(runner, '{"description": "nothing"}') is None


def test_an_empty_answer_is_none(runner):
    assert parse(runner, "   ") is None


# ---------------------------------------------------------------------------
# Project context
# ---------------------------------------------------------------------------


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    # `newline="\n"`: the runner filters samples by size on disk, and Windows
    # would otherwise write "\r\n" and push a fixture past SAMPLE_MAX_BYTES.
    path.write_text(text, encoding="utf-8", newline="\n")
    return path


BODY = "\n".join(f"export const value{i} = {i};" for i in range(40))


def test_the_language_is_detected_from_the_files(runner, tmp_path):
    for i in range(5):
        write(tmp_path / "api" / f"m{i}.py", "x = 1\n" * 60)
    write(tmp_path / "web" / "Button.tsx", BODY)

    files = runner.list_project_files(tmp_path)

    assert runner.detect_language(files, "function") == "python"
    # A component is front-end code, whatever the backend weighs.
    assert runner.detect_language(files, "component") == "typescript"


def test_the_sample_matches_the_kind_of_snippet(runner, tmp_path):
    write(tmp_path / "src" / "lib" / "format.ts", BODY)
    write(tmp_path / "src" / "hooks" / "useCounter.ts", BODY)
    write(tmp_path / "src" / "hooks" / "useCounter.test.ts", BODY)
    files = runner.list_project_files(tmp_path)

    assert (
        runner.pick_sample(tmp_path, files, "typescript", "hook")
        == "src/hooks/useCounter.ts"
    )
    assert (
        runner.pick_sample(tmp_path, files, "typescript", "test")
        == "src/hooks/useCounter.test.ts"
    )
    assert runner.pick_sample(tmp_path, files, "elixir", "function") is None


def test_the_context_reads_style_and_a_sample(runner, tmp_path):
    write(tmp_path / ".editorconfig", "[*]\nindent_style = tab\n")
    write(tmp_path / "biome.json", "{}")
    write(tmp_path / "src" / "utils" / "slug.ts", BODY)
    write(tmp_path / "node_modules" / "dep" / "index.ts", BODY)

    context = runner.gather_snippet_context(tmp_path, "utility", None)

    assert context.language == "typescript"
    assert context.language_source == "detected"
    assert "indent_style = tab" in context.text
    assert "biome.json" in context.text
    assert '<code_sample path="src/utils/slug.ts">' in context.text
    assert "node_modules" not in context.text
    assert context.sources == [".editorconfig", "biome.json", "src/utils/slug.ts"]


def test_a_sample_with_a_secret_is_not_sent(runner, tmp_path):
    # Built at run time so this file does not trip the pre-commit secret scan.
    key = "AKIA" + "IOSFODNN7" + "EXAMPLE"
    write(tmp_path / "src" / "client.py", f'AWS_KEY = "{key}"\n' + "x = 1\n" * 60)

    context = runner.gather_snippet_context(tmp_path, "function", "python")

    assert "AKIA" not in context.text
    assert "src/client.py" not in context.sources


def test_a_sample_is_not_sent_when_the_scanner_cannot_load(
    runner, monkeypatch, tmp_path
):
    write(tmp_path / "src" / "util.py", "x = 1\n" * 60)
    monkeypatch.setitem(sys.modules, "security.scan_secrets", None)

    context = runner.gather_snippet_context(tmp_path, "function", "python")

    assert "<code_sample" not in context.text


def test_the_context_is_bounded(runner, tmp_path):
    write(tmp_path / "README.md", "x" * 50_000)
    write(tmp_path / "AGENTS.md", "y" * 50_000)
    write(tmp_path / ".editorconfig", "z" * 50_000)
    write(tmp_path / "src" / "big.py", "w = 1\n" * 9_000)

    context = runner.gather_snippet_context(tmp_path, "function", "python")

    from core.project_brief import CONTEXT_BUDGET

    budget = CONTEXT_BUDGET + runner.STYLE_EXCERPT + runner.SAMPLE_EXCERPT + 1000
    assert len(context.text) <= budget
    assert "src/big.py" in context.sources


def test_the_optimizer_still_exposes_the_shared_brief():
    """The brief moved to `core.project_brief`; the optimizer re-exports it."""
    path = RUNNER.with_name("prompt_optimizer_runner.py")
    spec = importlib.util.spec_from_file_location("optimizer_reexport", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    from core import project_brief

    assert module.gather_project_context is project_brief.gather_project_context

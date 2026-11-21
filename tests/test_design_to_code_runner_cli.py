"""The Design-to-Code runner, run as the Design-to-Code page runs it.

The pipeline is the real service: spec, design tokens, visual tests, the
accessibility score, the files written. Only its two model calls are
stand-ins (the vision answer is the service's own sample analysis), and the
Figma API is reached through httpx with only the transport replaced.
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
from pathlib import Path

import httpx
import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "design_to_code_runner.py"
RESULT = "__DESIGN_TO_CODE_RESULT__:"
ERROR = "__DESIGN_TO_CODE_ERROR__:"
PHASE = "__DESIGN_TO_CODE_PHASE__:"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
FILES = [
    {
        "path": "src/components/Header.tsx",
        "content": "export const Header = () => <header><h1>Shop</h1></header>;\n",
        "language": "tsx",
    },
    {
        "path": "src/screens/Home.tsx",
        "content": "export const Home = () => <img src='hero.png' />;\n",
        "language": "tsx",
    },
    {"path": "../outside.tsx", "content": "escape\n"},
    {"path": "/etc/absolute.tsx", "content": "escape\n"},
]


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("design_to_code_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def model(monkeypatch):
    """The service's two model calls, answered; returns the prompts seen."""
    from services.design_to_code_service import DesignToCodeService

    seen: dict = {"vision": [], "code": [], "files": FILES}
    monkeypatch.delenv("FIGMA_ACCESS_TOKEN", raising=False)

    async def vision(self, image_data, prompt):
        seen["vision"].append(image_data)
        return self._mock_vision_analysis()

    async def code(self, prompt):
        seen["code"].append(prompt)
        if isinstance(seen["files"], Exception):
            raise seen["files"]
        return "```json\n" + json.dumps(seen["files"]) + "\n```"

    monkeypatch.setattr(DesignToCodeService, "_call_vision_ai", vision)
    monkeypatch.setattr(DesignToCodeService, "_call_code_generation_ai", code)
    return seen


def _main(runner, monkeypatch, *args: str) -> int:
    monkeypatch.setattr(sys, "argv", ["design_to_code_runner.py", *args])
    with pytest.raises(SystemExit) as stop:
        asyncio.run(runner.main())
    return stop.value.code


def _line(out: str, prefix: str):
    [line] = [x for x in out.splitlines() if x.startswith(prefix)]
    payload = line[len(prefix) :]
    return json.loads(payload) if prefix == RESULT else payload


def test_a_screenshot_becomes_files_written_inside_the_project(
    runner, model, tmp_path, monkeypatch, capsys
) -> None:
    project = tmp_path / "shop"
    project.mkdir()
    (project / "tokens.css").write_text(
        ":root { --brand: #0055ff; }\n", encoding="utf-8"
    )
    image = tmp_path / "home.PNG"
    image.write_bytes(PNG)

    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(project),
        "--image-path",
        str(image),
        "--framework",
        "react",
        "--style",
        "tailwind",
        "--instructions",
        "Use the brand colour.",
    )

    out = capsys.readouterr().out
    result = _line(out, RESULT)
    assert code == 0 and result["success"] is True
    assert model["vision"] == [
        "data:image/png;base64," + base64.b64encode(PNG).decode()
    ]
    assert "Use the brand colour." in model["code"][0]
    assert (project / "src" / "components" / "Header.tsx").is_file()
    assert (project / "src" / "screens" / "Home.tsx").is_file()
    # Paths from the model never leave the output folder.
    assert not (tmp_path / "outside.tsx").exists()
    assert "skipped (outside the output directory): ../outside.tsx" in out
    assert "skipped (outside the output directory): /etc/absolute.tsx" in out
    visual = [p.name for p in (project / "tests" / "visual").iterdir()]
    assert visual and all(name.endswith(".spec.ts") for name in visual)
    assert "accessibility" in result
    assert any(line.startswith(PHASE) for line in out.splitlines())
    assert "Files generated: 4" in out


def test_no_write_returns_the_files_for_review(
    runner, model, tmp_path, monkeypatch, capsys
) -> None:
    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-data",
        "data:image/png;base64,AAAA",
        "--framework",
        "vue",
        "--no-write",
        "--no-tests",
        "--no-tokens",
        "--json",
    )

    out = capsys.readouterr().out
    assert code == 0
    assert model["vision"] == ["data:image/png;base64,AAAA"]
    assert list(tmp_path.iterdir()) == []
    result = _line(out, RESULT)
    assert result["success"] is True
    # --json prints the same result, indented, before the result line.
    printed = out[out.index("\n{\n") + 1 : out.index(RESULT)]
    assert json.loads(printed) == result


@pytest.mark.parametrize(
    ("suffix", "mime"), [(".svg", "image/svg+xml"), (".bmp", "image/png")]
)
def test_the_image_type_follows_its_extension(
    runner, model, tmp_path, monkeypatch, capsys, suffix, mime
) -> None:
    image = tmp_path / f"design{suffix}"
    image.write_bytes(b"<svg/>")

    _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-path",
        str(image),
        "--no-write",
    )

    assert model["vision"][0].startswith(f"data:{mime};base64,")


@pytest.mark.parametrize(
    "image_args",
    [[], ["--image-path", "missing.png"]],
)
def test_without_an_image_nothing_runs(
    runner, model, tmp_path, monkeypatch, capsys, image_args
) -> None:
    code = _main(runner, monkeypatch, "--project-dir", str(tmp_path), *image_args)

    assert code == 1
    assert _line(capsys.readouterr().out, ERROR).startswith("No image data provided")
    assert model["vision"] == []


def test_a_failed_generation_returns_the_full_result_and_exits_1(
    runner, model, tmp_path, monkeypatch, capsys
) -> None:
    model["files"] = RuntimeError("provider quota reached")

    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-data",
        "data:image/png;base64,AAAA",
    )

    out = capsys.readouterr().out
    assert code == 1
    result = _line(out, RESULT)
    assert result["success"] is False
    assert any("provider quota reached" in e for e in result["errors"])
    assert "❌ " in out


def test_a_crash_is_reported_on_the_error_line(
    runner, tmp_path, monkeypatch, capsys
) -> None:
    from services.design_to_code_service import DesignToCodeService

    async def crash(self, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(DesignToCodeService, "run_pipeline", crash)

    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-data",
        "data:image/png;base64,AAAA",
    )

    assert code == 1
    assert _line(capsys.readouterr().out, ERROR) == "disk full"


# --- Figma ---------------------------------------------------------------------------

FIGMA_URL = "https://www.figma.com/design/AbC123xyz/Shop?node-id=12-34"


@pytest.fixture
def figma(monkeypatch):
    sent: list[httpx.Request] = []
    real = httpx.AsyncClient
    state = {"fail": False}

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        if state["fail"]:
            return httpx.Response(403, json={"err": "Invalid token"})
        if request.url.host == "api.figma.com":
            node = request.url.params["ids"]
            return httpx.Response(
                200, json={"images": {node: "https://figma-images.example.test/n.png"}}
            )
        return httpx.Response(200, content=PNG)

    def client(*args, **kwargs):
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    monkeypatch.setenv(
        "FIGMA_ACCESS_TOKEN", "figd-test-0000"
    )  # pragma: allowlist secret
    state["sent"] = sent
    return state


def test_a_figma_frame_is_exported_and_used_as_the_design(
    runner, model, figma, tmp_path, monkeypatch, capsys
) -> None:
    monkeypatch.setenv(
        "FIGMA_ACCESS_TOKEN", "figd-test-0000"
    )  # pragma: allowlist secret

    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--figma-url",
        FIGMA_URL,
        "--source-type",
        "figma",
        "--no-write",
    )

    assert code == 0, capsys.readouterr().out
    assert model["vision"] == [
        "data:image/png;base64," + base64.b64encode(PNG).decode()
    ]
    assert figma["sent"][0].url.path == "/v1/images/AbC123xyz"


def test_a_figma_export_that_fails_leaves_no_image(
    runner, model, figma, tmp_path, monkeypatch, capsys
) -> None:
    figma["fail"] = True

    code = _main(
        runner, monkeypatch, "--project-dir", str(tmp_path), "--figma-url", FIGMA_URL
    )

    assert code == 1
    assert _line(capsys.readouterr().out, ERROR).startswith("No image data provided")
    assert model["vision"] == []


def test_the_backend_env_file_is_loaded_when_there_is_one(monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    import cli.utils

    env_file = BACKEND.parent.parent / ".env-files" / ".env"
    loaded: list[Path] = []
    real_exists = Path.exists
    monkeypatch.setattr(
        Path, "exists", lambda self: self == env_file or real_exists(self)
    )
    monkeypatch.setattr(cli.utils, "import_dotenv", lambda: loaded.append)
    spec = importlib.util.spec_from_file_location("design_to_code_env_t", RUNNER)
    spec.loader.exec_module(importlib.util.module_from_spec(spec))
    assert loaded == [env_file]


def test_the_process_without_an_image_says_so(tmp_path: Path) -> None:
    import subprocess

    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(tmp_path)],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )

    assert done.returncode == 1
    assert _line(done.stdout, ERROR).startswith("No image data provided")


def test_strict_offline_makes_no_figma_export(
    runner, model, figma, tmp_path, monkeypatch, capsys
) -> None:
    from services.design_to_code_providers import STRICT_OFFLINE_REFUSAL

    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir(parents=True)
    policy.write_text(json.dumps({"airgapStrict": True}), encoding="utf-8")

    code = _main(
        runner, monkeypatch, "--project-dir", str(tmp_path), "--figma-url", FIGMA_URL
    )

    assert code == 1
    assert _line(capsys.readouterr().out, ERROR) == STRICT_OFFLINE_REFUSAL
    assert figma["sent"] == []
    assert model["vision"] == []


def test_the_render_loop_refines_the_files_and_reports_each_iteration(
    runner, model, tmp_path, monkeypatch, capsys
) -> None:
    seen: dict = {}

    async def fake_loop(service, result, *, image_data, framework, config, on_progress):
        seen.update(image=image_data, framework=framework, config=config)
        on_progress({"stage": "correct", "iteration": 1, "max_iterations": 3})
        result.generated_files[0].content = "corrected\n"
        return {"status": "converged", "iterations": []}

    monkeypatch.setattr(
        "services.design_to_code_render_loop.run_render_loop", fake_loop
    )
    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-data",
        "data:image/png;base64,AAAA",
        "--no-write",
        "--render-loop",
        "--loop-max-iterations",
        "3",
        "--loop-threshold",
        "0.9",
        "--loop-budget-seconds",
        "120",
        "--loop-max-tokens",
        "50000",
        "--loop-max-cost",
        "0.5",
        "--loop-responsive",
        "--loop-states",
    )
    out = capsys.readouterr().out
    result = _line(out, RESULT)
    assert code == 0 and result["render_loop"] == {
        "status": "converged",
        "iterations": [],
    }
    assert result["generated_files"][0]["content"] == "corrected\n"
    assert (seen["config"].max_iterations, seen["config"].threshold) == (3, 0.9)
    assert seen["config"].budget_seconds == 120 and seen["framework"] == "react"
    assert (seen["config"].max_tokens, seen["config"].max_cost_usd) == (50_000, 0.5)
    assert seen["config"].responsive and seen["config"].states
    loop_lines = [
        json.loads(line[len(PHASE) :])
        for line in out.splitlines()
        if line.startswith(PHASE) and '"render_loop"' in line
    ]
    assert loop_lines == [
        {
            "phase": "render_loop",
            "status": "",
            "detail": {
                "loop": {"stage": "correct", "iteration": 1, "max_iterations": 3}
            },
        }
    ]


def test_without_the_flag_no_loop_runs(
    runner, model, tmp_path, monkeypatch, capsys
) -> None:
    async def fail(*args, **kwargs):
        raise AssertionError("the loop must not run")

    monkeypatch.setattr("services.design_to_code_render_loop.run_render_loop", fail)
    code = _main(
        runner,
        monkeypatch,
        "--project-dir",
        str(tmp_path),
        "--image-data",
        "data:image/png;base64,AAAA",
        "--no-write",
    )
    assert code == 0 and "render_loop" not in _line(capsys.readouterr().out, RESULT)


@pytest.mark.parametrize(
    ("flag", "value"),
    [
        ("--loop-max-iterations", "0"),
        ("--loop-max-iterations", "11"),
        ("--loop-threshold", "1.5"),
        ("--loop-budget-seconds", "5"),
        ("--loop-max-tokens", "100"),
        ("--loop-max-tokens", "9000000"),
        ("--loop-max-cost", "0"),
        ("--loop-max-cost", "nan"),
        ("--loop-max-cost", "1000"),
    ],
)
def test_loop_bounds_are_refused_outside_their_range(
    runner, tmp_path, monkeypatch, capsys, flag, value
) -> None:
    code = _main(runner, monkeypatch, "--project-dir", str(tmp_path), flag, value)
    assert code == 2 and "expected" in capsys.readouterr().err

"""Which esbuild the merge's syntax check runs, on every OS and package layout."""

from __future__ import annotations

import subprocess
from pathlib import Path

import foundation.platform as platform
import pytest
from core.workspace import git_utils

ARGS = ["merged.tsx", "--log-level=error"]


def touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")
    return path


def on(monkeypatch, *, windows: bool, found: dict[str, str] | None = None) -> None:
    """Run as ``windows`` says, with ``found`` as the executables on the PATH."""
    monkeypatch.setattr(git_utils, "is_windows", lambda: windows)
    monkeypatch.setattr(platform, "is_windows", lambda: windows)
    monkeypatch.setattr(
        git_utils, "find_executable", lambda name: (found or {}).get(name)
    )


class TestWindows:
    def test_the_native_binary_of_an_npm_install_runs(self, tmp_path, monkeypatch):
        on(monkeypatch, windows=True, found={"node": r"C:\nodejs\node.exe"})
        modules = tmp_path / "node_modules"
        touch(modules / "esbuild" / "bin" / "esbuild")
        native = touch(modules / "@esbuild" / "win32-x64" / "esbuild.exe")

        assert git_utils._esbuild_command(tmp_path, ARGS) == [str(native), *ARGS]

    def test_the_native_binary_next_to_a_pnpm_package_runs(self, tmp_path, monkeypatch):
        on(monkeypatch, windows=True)
        project = tmp_path / "apps" / "web"
        project.mkdir(parents=True)
        store = tmp_path / "apps" / "node_modules" / ".pnpm" / "esbuild@0.25.0"
        touch(store / "node_modules" / "esbuild" / "bin" / "esbuild")
        native = touch(
            store / "node_modules" / "@esbuild" / "win32-arm64" / "esbuild.exe"
        )

        assert git_utils._esbuild_command(project, ARGS) == [str(native), *ARGS]

    def test_without_the_native_binary_node_runs_the_package_script(
        self, tmp_path, monkeypatch
    ):
        on(monkeypatch, windows=True, found={"node": r"C:\nodejs\node.exe"})
        script = touch(tmp_path / "node_modules" / "esbuild" / "bin" / "esbuild")

        assert git_utils._esbuild_command(tmp_path, ARGS) == [
            r"C:\nodejs\node.exe",
            str(script),
            *ARGS,
        ]

    def test_the_shell_shim_is_not_run_and_npx_goes_through_cmd(
        self, tmp_path, monkeypatch
    ):
        # Without Node the package script cannot run, and .bin/esbuild is a
        # POSIX shell script on Windows: npx.cmd is what is left.
        on(monkeypatch, windows=True, found={"npx": r"C:\nodejs\npx.cmd"})
        monkeypatch.setenv("ComSpec", r"C:\Windows\System32\cmd.exe")
        touch(tmp_path / "node_modules" / "esbuild" / "bin" / "esbuild")
        touch(tmp_path / "node_modules" / ".bin" / "esbuild")

        command = git_utils._esbuild_command(tmp_path, ARGS)

        assert command[:4] == [r"C:\Windows\System32\cmd.exe", "/d", "/s", "/c"]
        assert command[4] == r'"C:\nodejs\npx.cmd" esbuild merged.tsx --log-level=error'


class TestElsewhere:
    @pytest.mark.parametrize("found", [{}, {"node": "/usr/bin/node"}])
    def test_the_package_binary_runs_itself(self, tmp_path, monkeypatch, found):
        on(monkeypatch, windows=False, found=found)
        binary = touch(tmp_path / "node_modules" / "esbuild" / "bin" / "esbuild")

        assert git_utils._esbuild_command(tmp_path, ARGS) == [str(binary), *ARGS]

    def test_the_bin_shim_runs_when_the_package_is_elsewhere(
        self, tmp_path, monkeypatch
    ):
        on(monkeypatch, windows=False)
        shim = touch(tmp_path / "node_modules" / ".bin" / "esbuild")

        assert git_utils._esbuild_command(tmp_path, ARGS) == [str(shim), *ARGS]

    def test_npx_from_the_path_otherwise(self, tmp_path, monkeypatch):
        on(monkeypatch, windows=False, found={"npx": "/opt/node/bin/npx"})

        assert git_utils._esbuild_command(tmp_path, ARGS) == [
            "/opt/node/bin/npx",
            "esbuild",
            *ARGS,
        ]

    def test_bare_npx_when_the_path_has_none(self, tmp_path, monkeypatch):
        on(monkeypatch, windows=False)

        assert git_utils._esbuild_command(tmp_path, ARGS) == ["npx", "esbuild", *ARGS]


class TestVerdict:
    """Only esbuild's own diagnostic says that a merged file is broken."""

    def answer(self, monkeypatch, stderr: str) -> None:
        def run(args, **_kwargs):
            return subprocess.CompletedProcess(args, 1, stdout="", stderr=stderr)

        monkeypatch.setattr(git_utils.subprocess, "run", run)

    @pytest.mark.parametrize(
        "stderr",
        [
            "/usr/bin/env: 'node': No such file or directory\n",
            "npm error code E404\nnpm error 404 Not Found - GET esbuild\n",
        ],
    )
    def test_esbuild_that_did_not_run_is_no_verdict(
        self, tmp_path, monkeypatch, stderr
    ):
        self.answer(monkeypatch, stderr)

        assert git_utils.validate_merged_syntax("a.ts", "x;", tmp_path) == (True, "")

    def test_what_comes_before_the_error_is_left_out(self, tmp_path, monkeypatch):
        self.answer(
            monkeypatch,
            "npm warn config\nsome tool: a warning\n"
            '✘ [ERROR] Expected ")" but found end of file\n\n'
            "    a.tsx:1:2:\n      1 │ f((\n",
        )

        assert git_utils.validate_merged_syntax("a.tsx", "f((", tmp_path) == (
            False,
            'Syntax error: ✘ [ERROR] Expected ")" but found end of file\n'
            "    a.tsx:1:2:\n      1 │ f((",
        )

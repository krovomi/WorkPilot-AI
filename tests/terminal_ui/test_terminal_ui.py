"""The terminal UI of the CLI: boxes, colours, menus, the build status file and
the ccstatusline provider.

Capabilities (colour, Unicode, fancy boxes, interactivity) are read once at
import; each test sets the module attributes it depends on, so the output is
the same whatever terminal runs the suite. The status line runs as ccstatusline
starts it: ``python <backend>/ui/statusline.py`` from the project folder.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest
from ui import boxes, capabilities, colors, formatters, icons, menu, progress, spinner
from ui import statusline as statusline_module
from ui.menu import MenuOption, select_menu
from ui.status import BuildState, BuildStatus, StatusManager

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
STATUSLINE = BACKEND / "ui" / "statusline.py"


@pytest.fixture
def plain(monkeypatch):
    """ASCII icons, no colour, no fancy boxes."""
    for module in (icons,):
        monkeypatch.setattr(module, "UNICODE", False)
    for module in (colors, progress):
        monkeypatch.setattr(module, "COLOR", False)
    monkeypatch.setattr(boxes, "FANCY_UI", False)
    monkeypatch.setattr(capabilities, "COLOR", False)


@pytest.fixture
def fancy(monkeypatch):
    """Unicode icons, colours and box drawing."""
    monkeypatch.setattr(icons, "UNICODE", True)
    for module in (colors, progress, capabilities):
        monkeypatch.setattr(module, "COLOR", True)
    monkeypatch.setattr(boxes, "FANCY_UI", True)


def _visible(text: str) -> str:
    return boxes._ANSI.sub("", text)


# ── Capabilities ─────────────────────────────────────────────────────


class TestCapabilities:
    def test_fancy_ui_switch(self, monkeypatch):
        monkeypatch.setenv("ENABLE_FANCY_UI", "off")
        assert not capabilities._is_fancy_ui_enabled()
        assert not capabilities.supports_unicode()
        assert not capabilities.supports_color()
        assert not capabilities.supports_interactive()

        monkeypatch.setenv("ENABLE_FANCY_UI", "yes")
        assert capabilities._is_fancy_ui_enabled()

    def test_colour_rules(self, monkeypatch):
        monkeypatch.delenv("ENABLE_FANCY_UI", raising=False)
        monkeypatch.delenv("FORCE_COLOR", raising=False)
        monkeypatch.setenv("NO_COLOR", "1")
        assert not capabilities.supports_color()

        monkeypatch.delenv("NO_COLOR")
        monkeypatch.setenv("FORCE_COLOR", "1")
        assert capabilities.supports_color()

        monkeypatch.delenv("FORCE_COLOR")
        tty = types.SimpleNamespace(isatty=lambda: True, encoding="UTF-8")
        monkeypatch.setattr(sys, "stdout", tty)
        monkeypatch.setenv("TERM", "dumb")
        assert not capabilities.supports_color()
        monkeypatch.setenv("TERM", "xterm-256color")
        assert capabilities.supports_color()
        assert capabilities.supports_unicode()

        monkeypatch.setattr(sys, "stdout", types.SimpleNamespace(encoding=None))
        assert not capabilities.supports_color()
        assert not capabilities.supports_unicode()

    def test_interactive_needs_a_terminal_on_stdin(self, monkeypatch):
        monkeypatch.delenv("ENABLE_FANCY_UI", raising=False)
        monkeypatch.setattr(sys, "stdin", types.SimpleNamespace(isatty=lambda: True))
        assert capabilities.supports_interactive()
        monkeypatch.setattr(sys, "stdin", object())
        assert not capabilities.supports_interactive()

    def test_off_windows_nothing_is_configured(self, monkeypatch):
        monkeypatch.setattr(capabilities, "is_windows", lambda: False)
        before = sys.stdout

        capabilities.configure_safe_encoding()

        assert sys.stdout is before
        assert capabilities.enable_windows_ansi_support() is True


class _Console:
    """kernel32 as far as the ANSI switch uses it."""

    def __init__(self, modes):
        self.modes = modes  # handle id -> console mode, or None (no console)
        self.set: list[tuple[int, int]] = []

    def GetStdHandle(self, handle_id):
        return -1 if self.modes.get(handle_id, "absent") == "absent" else handle_id

    def GetConsoleMode(self, handle, mode_ref):
        mode = self.modes[handle]
        if mode is None:
            return 0
        mode_ref.value = mode
        return 1

    def SetConsoleMode(self, handle, mode):
        self.set.append((handle, mode))
        return 1


def _fake_ctypes(console):
    class DWORD:
        def __init__(self):
            self.value = 0

    return types.SimpleNamespace(
        windll=types.SimpleNamespace(kernel32=console),
        wintypes=types.SimpleNamespace(DWORD=DWORD),
        byref=lambda ref: ref,
    )


class TestWindowsConsole:
    def test_virtual_terminal_is_switched_on_where_it_is_off(self, monkeypatch):
        console = _Console({-11: 0x0003, -12: 0x0007})
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setitem(sys.modules, "ctypes", _fake_ctypes(console))

        assert capabilities.enable_windows_ansi_support() is True
        assert console.set == [(-11, 0x0007)]

    def test_handles_without_a_console_are_skipped(self, monkeypatch):
        console = _Console({-12: None})  # stdout absent, stderr not a console
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setitem(sys.modules, "ctypes", _fake_ctypes(console))

        assert capabilities.enable_windows_ansi_support() is True
        assert console.set == []

    def test_without_the_api_colorama_takes_over(self, monkeypatch):
        calls = []
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setitem(sys.modules, "ctypes", types.SimpleNamespace())
        monkeypatch.setitem(
            sys.modules, "colorama", types.SimpleNamespace(init=lambda: calls.append(1))
        )

        assert capabilities.enable_windows_ansi_support() is True
        assert calls == [1]

    def test_without_api_nor_colorama(self, monkeypatch):
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setitem(sys.modules, "ctypes", types.SimpleNamespace())
        monkeypatch.setitem(sys.modules, "colorama", None)

        assert capabilities.enable_windows_ansi_support() is False

    def test_streams_are_reconfigured_or_wrapped_in_utf8(self, monkeypatch):
        import io

        class Reconfigurable:
            def __init__(self):
                self.settings = None

            def reconfigure(self, **settings):
                self.settings = settings

        class Refusing:
            def __init__(self):
                self.buffer = io.BytesIO()

            def reconfigure(self, **_settings):
                raise io.UnsupportedOperation("pipe")

        out, err = Reconfigurable(), Refusing()
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setattr(sys, "stdout", out)
        monkeypatch.setattr(sys, "stderr", err)

        capabilities.configure_safe_encoding()

        assert out.settings == {"encoding": "utf-8", "errors": "replace"}
        assert sys.stdout is out
        assert isinstance(sys.stderr, io.TextIOWrapper)
        assert sys.stderr.encoding == "utf-8"

    def test_a_stream_that_cannot_be_wrapped_is_left_alone(self, monkeypatch):
        bare = types.SimpleNamespace()
        odd = types.SimpleNamespace(buffer=object())  # not a binary stream
        monkeypatch.setattr(capabilities, "is_windows", lambda: True)
        monkeypatch.setattr(sys, "stdout", bare)
        monkeypatch.setattr(sys, "stderr", odd)

        capabilities.configure_safe_encoding()

        assert sys.stdout is bare
        assert sys.stderr is odd


# ── Colours, icons, boxes, progress ──────────────────────────────────


class TestStyling:
    def test_colours_only_when_supported(self, monkeypatch):
        monkeypatch.setattr(colors, "COLOR", True)
        assert colors.success("ok") == "\033[92mok\033[0m"
        for fn in (
            colors.error,
            colors.warning,
            colors.info,
            colors.muted,
            colors.highlight,
            colors.bold,
        ):
            assert fn("x").endswith("x\033[0m")
        assert colors.color("x") == "x"

        monkeypatch.setattr(colors, "COLOR", False)
        assert colors.success("ok") == "ok"

    def test_icons_fall_back_to_ascii(self, monkeypatch):
        monkeypatch.setattr(icons, "UNICODE", True)
        assert icons.icon(icons.Icons.SUCCESS) == "✓"
        monkeypatch.setattr(icons, "UNICODE", False)
        assert icons.icon(icons.Icons.SUCCESS) == "[OK]"

    def test_plain_boxes_strip_colour(self, plain):
        drawn = boxes.box("\033[92mready\033[0m\nsecond", title="Build", width=10)

        assert drawn.splitlines() == [
            "==========",
            "  Build",
            "==========",
            "  ready",
            "  second",
            "==========",
        ]
        assert boxes.box(["x"], width=4, style="light").splitlines()[0] == "----"

    @pytest.mark.parametrize("align", ["left", "center", "right"])
    def test_every_line_of_a_box_has_the_same_width(self, fancy, align):
        drawn = boxes.box(
            [colors.success("short"), "x" * 200, "word " * 30, colors.info("y" * 100)],
            title=colors.bold("Title"),
            width=40,
            title_align=align,
        )

        assert {len(_visible(line)) for line in drawn.splitlines()} == {40}

    def test_a_cut_coloured_line_closes_its_colour(self, fancy):
        drawn = boxes.box([colors.success("a" * 100)], width=30, style="light")

        line = drawn.splitlines()[1]
        assert line == "│ \033[92m" + "a" * 23 + "\033[0m... │"

    def test_a_cut_right_where_the_colour_starts(self, fancy):
        line = "a" * 23 + colors.success("b" * 20)

        drawn = boxes.box([line], width=30).splitlines()[1]

        assert drawn == "║ " + "a" * 23 + "\033[92m\033[0m... ║"

    def test_a_cut_at_a_word_boundary_keeps_the_border_aligned(self, fancy):
        drawn = boxes.box(["word " * 20], width=30).splitlines()[1]

        assert drawn == "║ " + "word word word word" + "..." + " " * 4 + " ║"

    def test_a_line_too_long_for_a_tiny_box(self, fancy):
        assert (
            boxes.box(["abcdef"], width=6).splitlines()[1] == "║ ...║"
        )  # still 6 wide

    def test_dividers(self, fancy):
        assert boxes.divider(3) == "═══"
        assert boxes.divider(3, style="light") == "───"
        assert boxes.divider(3, char="*") == "***"

    @pytest.mark.parametrize(
        ("current", "total", "bar", "label"),
        [
            (0, 0, "[    ]", "0/0 (0%)"),
            (1, 4, "[#   ]", "1/4 (25%)"),
            (9, 4, "[####]", "9/4 (225%)"),
            (-1, 4, "[    ]", "-1/4 (-25%)"),
        ],
    )
    def test_progress_bar_stays_its_width(
        self, plain, monkeypatch, current, total, bar, label
    ):
        monkeypatch.setattr(icons.Icons, "BAR_FULL", ("█", "#"))
        monkeypatch.setattr(icons.Icons, "BAR_EMPTY", ("░", " "))

        assert progress.progress_bar(current, total, width=4) == f"{bar} {label}"
        assert (
            progress.progress_bar(1, 4, width=4, show_count=False, show_percent=False)
            == "[#   ]"
        )

    @pytest.mark.parametrize(
        ("current", "colour"),
        [
            (4, colors.Color.SUCCESS),
            (2, colors.Color.INFO),
            (1, colors.Color.WARNING),
            (0, colors.Color.MUTED),
        ],
    )
    def test_progress_colour_follows_the_progress(self, fancy, current, colour):
        assert progress.progress_bar(current, 4, width=4).startswith(f"[{colour}")


class TestFormatters:
    def test_headers_sections_and_statuses(self, plain, capsys):
        formatters.print_header(
            "Build", subtitle="spec 001", icon_tuple=icons.Icons.PLAY, width=20
        )
        formatters.print_section("Phase", width=20)
        formatters.print_status("done", "success")
        formatters.print_status("odd", "unknown-status")
        formatters.print_status("custom", icon_tuple=("*", "*"))
        formatters.print_key_value("Spec", "001")
        formatters.print_phase_status("Setup", 1, 3, "in_progress")
        formatters.print_phase_status("Other", 0, 3, "weird")

        out = capsys.readouterr().out.splitlines()
        assert "  > Build" in out
        assert "  spec 001" in out
        assert "  Phase" in out
        assert "[OK] done" in out
        assert "[i] odd" in out
        assert "* custom" in out
        assert "  Spec: 001" in out
        assert "  [.] Setup: 1/3" in out
        assert "  [ ] Other: 0/3" in out


class TestSpinner:
    def test_frames_message_and_final_status(self, plain, monkeypatch, capsys):
        monkeypatch.setattr(spinner.Spinner, "FRAMES", ["|", "/"])
        # The module the spinner really colours with, even if another test
        # left a different `ui` package in sys.modules.
        monkeypatch.setitem(spinner.highlight.__globals__, "COLOR", True)
        turning = spinner.Spinner("Working")

        turning.start()
        turning.update("Still working")
        turning.update()
        turning.stop("Finished", "success")
        turning.stop()

        out = capsys.readouterr().out
        assert out.startswith("\r\033[96m|\033[0m Working")
        assert "\r\033[96m/\033[0m Still working" in out
        assert out.count("\r\033[K") == 2
        assert "Finished" in out


# ── Menus ────────────────────────────────────────────────────────────


OPTIONS = [
    MenuOption("build", "Build", icon=icons.Icons.PLAY, description="Run the build"),
    MenuOption("off", "Unavailable", disabled=True),
    MenuOption("review", "Review"),
]


@pytest.fixture
def keys(monkeypatch, plain):
    """Interactive menu fed by a list of keys."""
    pressed: list[str] = []
    monkeypatch.setattr(menu, "INTERACTIVE", True)

    def getch():
        if not pressed:
            raise RuntimeError("no more keys")
        return pressed.pop(0)

    monkeypatch.setattr(menu, "_getch", getch)
    return pressed


class TestInteractiveMenu:
    @pytest.mark.parametrize(
        ("pressed", "chosen"),
        [
            (["\r"], "build"),
            (["DOWN", "\n"], "review"),  # the disabled option is skipped
            (["j", "j", "k", "\r"], "build"),
            (["UP", "DOWN", "DOWN", "\r"], "review"),
            (["2", "3"], "review"),  # 2 is disabled
            (["q"], None),
            (["", "LEFT", "x", "\r"], "build"),  # unknown keys are ignored
        ],
    )
    def test_keys(self, keys, capsys, pressed, chosen):
        keys.extend(pressed)

        assert select_menu("Pick", OPTIONS, subtitle="What next?") == chosen
        assert "Pick" in capsys.readouterr().out

    def test_q_without_quit_is_ignored(self, keys):
        keys.extend(["q", "\r"])

        assert select_menu("Pick", OPTIONS, allow_quit=False) == "build"

    def test_ctrl_c_interrupts(self, keys):
        keys.append("\x03")

        with pytest.raises(KeyboardInterrupt):
            select_menu("Pick", OPTIONS)

    def test_no_enabled_option(self, keys, capsys):
        assert select_menu("Pick", [MenuOption("a", "A", disabled=True)]) is None
        assert "No valid options available" in capsys.readouterr().out

    def test_a_terminal_that_cannot_read_keys_falls_back(self, keys, monkeypatch):
        monkeypatch.setattr("builtins.input", lambda _prompt: "3")

        assert select_menu("Pick", OPTIONS) == "review"


class TestFallbackMenu:
    @pytest.fixture(autouse=True)
    def not_interactive(self, monkeypatch, plain):
        monkeypatch.setattr(menu, "INTERACTIVE", False)

    def _answers(self, monkeypatch, *answers):
        queue = list(answers)

        def answer(_prompt):
            value = queue.pop(0)
            if isinstance(value, BaseException):
                raise value
            return value

        monkeypatch.setattr("builtins.input", answer)

    def test_numbers_until_a_valid_one(self, monkeypatch, capsys):
        self._answers(monkeypatch, "two", "2", "9", " 1 ")

        assert select_menu("Pick", OPTIONS, subtitle="Next?") == "build"
        out = capsys.readouterr().out
        assert "  [1] > Build" in out
        assert "  [2] Unavailable (disabled)" in out
        assert "      Run the build" in out
        assert "  [q] Quit" in out
        assert out.count("Invalid choice, please try again.") == 3

    def test_quit_and_end_of_input(self, monkeypatch):
        self._answers(monkeypatch, "Q")
        assert select_menu("Pick", OPTIONS) is None
        self._answers(monkeypatch, EOFError())
        assert select_menu("Pick", OPTIONS, allow_quit=False) is None


def _probe_menu(monkeypatch, **modules):
    """A fresh copy of ui/menu.py imported with ``modules`` in sys.modules."""
    import importlib.util

    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location("ui._menu_probe", menu.__file__)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe


class TestRawKeys:
    def test_windows_has_msvcrt_and_no_termios(self, monkeypatch):
        probe = _probe_menu(
            monkeypatch, termios=None, tty=None, msvcrt=types.SimpleNamespace()
        )

        assert (probe._HAS_TERMIOS, probe._HAS_MSVCRT) == (False, True)

    def test_unix_has_termios_and_no_msvcrt(self, monkeypatch):
        probe = _probe_menu(monkeypatch, msvcrt=None)

        assert probe._HAS_MSVCRT is False

    def test_windows_keys(self, monkeypatch):
        reads = iter(
            [
                b"\xe0",
                b"H",
                b"\x00",
                b"P",
                b"\xe0",
                b"M",
                b"\xe0",
                b"K",
                b"\xe0",
                b"?",
                b"a",
            ]
        )
        monkeypatch.setattr(menu, "_HAS_MSVCRT", True)
        monkeypatch.setattr(
            menu,
            "msvcrt",
            types.SimpleNamespace(getch=lambda: next(reads)),
            raising=False,
        )

        assert [menu._getch() for _ in range(6)] == [
            "UP",
            "DOWN",
            "RIGHT",
            "LEFT",
            "",
            "a",
        ]

    def test_unix_escape_sequences(self, monkeypatch):
        restored = []
        fake_termios = types.SimpleNamespace(
            tcgetattr=lambda fd: "saved",
            tcsetattr=lambda fd, when, settings: restored.append(settings),
            TCSADRAIN=1,
        )
        stream = iter("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[Zx\x1bO")

        class Stdin:
            def fileno(self):
                return 0

            def read(self, _n):
                return next(stream)

        monkeypatch.setattr(menu, "_HAS_MSVCRT", False)
        monkeypatch.setattr(menu, "_HAS_TERMIOS", True)
        monkeypatch.setattr(menu, "termios", fake_termios, raising=False)
        monkeypatch.setattr(
            menu, "tty", types.SimpleNamespace(setraw=lambda fd: None), raising=False
        )
        monkeypatch.setattr(sys, "stdin", Stdin())

        assert [menu._getch() for _ in range(7)] == [
            "UP",
            "DOWN",
            "RIGHT",
            "LEFT",
            "\x1b",
            "x",
            "\x1b",
        ]
        assert restored == ["saved"] * 7

    def test_no_raw_input(self, monkeypatch):
        monkeypatch.setattr(menu, "_HAS_MSVCRT", False)
        monkeypatch.setattr(menu, "_HAS_TERMIOS", False)

        with pytest.raises(RuntimeError, match="No raw input method"):
            menu._getch()


# ── Status file ──────────────────────────────────────────────────────


class TestStatusFile:
    def test_round_trip(self):
        status = BuildStatus(
            active=True,
            spec="001-login",
            state=BuildState.QA,
            subtasks_completed=2,
            subtasks_total=5,
            phase_current="Tests",
            workers_max=3,
            last_update="2026-11-15T00:00:00",
        )

        assert BuildStatus.from_dict(status.to_dict()) == status
        assert BuildStatus().to_dict()["last_update"]

    def test_updates_are_batched_then_flushed(self, tmp_path):
        manager = StatusManager(tmp_path)
        manager.set_active("001-login", BuildState.BUILDING)
        manager.update_subtasks(completed=1, total=4, in_progress=1, failed=0)
        manager.update_phase("Setup", 1, 3)
        manager.update_workers(2, max_workers=4)
        manager.update_workers(1)
        manager.update_session(7)
        manager.update(state=BuildState.PAUSED, not_a_field="ignored")
        manager.flush()
        manager.flush()  # nothing pending any more

        data = json.loads(manager.status_file.read_text(encoding="utf-8"))
        assert data["subtasks"] == {
            "completed": 1,
            "total": 4,
            "in_progress": 1,
            "failed": 0,
        }
        assert data["phase"] == {"current": "Setup", "id": 1, "total": 3}
        assert data["workers"] == {"active": 1, "max": 4}
        assert data["session"]["number"] == 7
        assert data["state"] == "paused"
        assert StatusManager(tmp_path).read().spec == "001-login"

    def test_a_debounced_write_lands_on_its_own(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DEBUG", "1")
        monkeypatch.setattr(StatusManager, "_WRITE_DEBOUNCE_MS", 1)
        manager = StatusManager(tmp_path)
        manager.update_session(1)
        manager.update_session(2)
        manager._write_timer.join(5)

        assert (
            json.loads(manager.status_file.read_text(encoding="utf-8"))["session"][
                "number"
            ]
            == 2
        )

    def test_an_immediate_write_cancels_the_pending_one(self, tmp_path):
        manager = StatusManager(tmp_path)
        manager.update_session(3)
        pending = manager._write_timer

        manager.write(BuildStatus(active=True, spec="002"), immediate=True)

        assert pending.finished.is_set() or not pending.is_alive()
        assert StatusManager(tmp_path).read().spec == "002"

    def test_set_inactive_and_clear(self, tmp_path):
        manager = StatusManager(tmp_path)
        manager.set_active("001", BuildState.PLANNING)
        manager.update_session(1)
        manager.set_inactive()
        assert StatusManager(tmp_path).read().state is BuildState.IDLE

        manager.update_session(2)
        manager.clear()
        manager.clear()
        assert not manager.status_file.exists()

    def test_a_status_file_that_cannot_be_removed(self, tmp_path, monkeypatch):
        manager = StatusManager(tmp_path)
        manager.set_active("001", BuildState.BUILDING)

        def refuse(self, *_a, **_k):
            raise PermissionError("in use")

        monkeypatch.setattr(Path, "unlink", refuse)
        manager.clear()

        assert manager.status_file.exists()

    def test_no_status_file_is_inactive(self, tmp_path):
        assert StatusManager(tmp_path).read() == BuildStatus()

    @pytest.mark.parametrize(
        "content",
        [
            "{broken",
            "[1, 2]",
            '{"state": "teleporting"}',
            '{"subtasks": [1]}',
            b"\xff\xfe",
        ],
    )
    def test_an_unreadable_status_is_inactive(self, tmp_path, content):
        status_file = tmp_path / ".workpilot-status"
        status_file.write_bytes(
            content if isinstance(content, bytes) else content.encode("utf-8")
        )

        assert StatusManager(tmp_path).read() == BuildStatus()

    def test_a_failed_write_is_reported_and_keeps_the_old_file(
        self, tmp_path, monkeypatch, capsys, plain
    ):
        manager = StatusManager(tmp_path)
        manager.set_active("001", BuildState.BUILDING)

        def refuse(*_a, **_k):
            raise PermissionError("read-only")

        monkeypatch.setitem(
            StatusManager._do_write.__globals__, "write_json_atomic", refuse
        )
        manager.set_inactive()

        assert "Could not write status file: read-only" in capsys.readouterr().out
        assert StatusManager(tmp_path).read().active is True


# ── Status line (ccstatusline) ───────────────────────────────────────


def _statusline(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    return subprocess.run(
        [sys.executable, str(STATUSLINE), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=60,
        check=False,
    )


def _write_status(project: Path, **fields) -> None:
    status = BuildStatus(active=True, spec="001-login", **fields)
    StatusManager(project).write(status, immediate=True)


class TestStatusLine:
    def test_runs_by_path_from_a_subfolder_of_the_project(self, tmp_path):
        project = tmp_path / "shop"
        (project / ".workpilot").mkdir(parents=True)
        (project / "src").mkdir()
        _write_status(
            project,
            state=BuildState.BUILDING,
            subtasks_completed=3,
            subtasks_total=12,
            phase_current="Setup",
            workers_active=2,
            workers_max=4,
        )

        done = _statusline(project / "src")

        assert done.returncode == 0, done.stderr
        assert done.stdout.strip() == "▣ 3/12 │ ◆ Setup → │ ⚡2 │ 25%"

    def test_full_and_json_formats(self, tmp_path):
        _write_status(
            tmp_path,
            state=BuildState.QA,
            subtasks_completed=1,
            subtasks_total=2,
            subtasks_in_progress=1,
            subtasks_failed=1,
            phase_current="QA",
            phase_id=3,
            phase_total=3,
            workers_active=1,
            workers_max=2,
            session_number=4,
        )

        full = _statusline(tmp_path, "--format", "full", "--project-dir", str(tmp_path))
        as_json = _statusline(tmp_path, "-f", "json", "-p", str(tmp_path))

        assert full.stdout.splitlines() == [
            "Spec: 001-login",
            "State: qa",
            "Progress: 1/2 subtasks (50%)",
            "In Progress: 1",
            "Failed: 1",
            "Phase: QA (3/3)",
            "Workers: 1/2",
            "Session: 4",
        ]
        assert json.loads(as_json.stdout)["spec"] == "001-login"

    def test_another_spec_reads_as_idle(self, tmp_path):
        _write_status(tmp_path, subtasks_total=1)

        assert _statusline(tmp_path, "--spec", "999").stdout == ""
        assert (
            _statusline(tmp_path, "-s", "999", "-f", "full").stdout.strip()
            == "No active build"
        )


class TestStatusLineFormats:
    @pytest.mark.parametrize(
        ("state", "prefix"),
        [
            (BuildState.PAUSED, "[P] "),
            (BuildState.COMPLETE, "[OK] "),
            (BuildState.ERROR, "[X] "),
            (BuildState.PLANNING, ""),
        ],
    )
    def test_compact_prefixes_and_ascii(self, plain, monkeypatch, state, prefix):
        monkeypatch.setattr(statusline_module, "supports_unicode", lambda: False)
        monkeypatch.setattr(icons.Icons, "PAUSE", ("⏸", "[P]"))
        status = BuildStatus(active=True, state=state, phase_current="Plan")

        line = statusline_module.format_compact(status)

        assert line == prefix + f"{icons.icon(icons.Icons.PHASE)} Plan"

    def test_inactive_is_empty(self):
        assert statusline_module.format_compact(BuildStatus()) == ""

    def test_project_root_is_found_upwards(self, tmp_path, monkeypatch):
        (tmp_path / ".workpilot-status").write_text("{}", encoding="utf-8")
        deep = tmp_path / "a" / "b"
        deep.mkdir(parents=True)

        monkeypatch.chdir(deep)
        assert statusline_module.find_project_root() == tmp_path
        monkeypatch.chdir(tmp_path)
        assert statusline_module.find_project_root() == tmp_path

    def test_a_workpilot_folder_marks_the_root(self, tmp_path, monkeypatch):
        (tmp_path / ".workpilot").mkdir()
        (tmp_path / "src").mkdir()

        monkeypatch.chdir(tmp_path / "src")
        assert statusline_module.find_project_root() == tmp_path

    def test_without_marker_the_folder_itself(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "exists", lambda self: False)
        monkeypatch.chdir(tmp_path)

        assert statusline_module.find_project_root() == Path.cwd()

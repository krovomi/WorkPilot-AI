"""What the build reads from the user: a file, or lines typed until an empty one."""

from __future__ import annotations

import pytest
from cli import input_handlers as ih


def _typed(monkeypatch, *answers):
    queue = list(answers)

    def fake_input(prompt=""):
        answer = queue.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr("builtins.input", fake_input)


def test_a_file_is_read_and_trimmed(tmp_path, monkeypatch, capsys):
    notes = tmp_path / "notes.md"
    notes.write_text("\n  Use the cache.  \n\n", encoding="utf-8")
    _typed(monkeypatch, f"  {notes}  ")

    assert ih.read_from_file() == "Use the cache."
    assert "Loaded 14 characters from file" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        ("", "No file path provided."),
        ("missing.md", "File not found:"),
        (KeyboardInterrupt(), "Cancelled."),
        (EOFError(), "Cancelled."),
    ],
)
def test_no_usable_file(tmp_path, monkeypatch, capsys, answer, message):
    monkeypatch.chdir(tmp_path)
    _typed(monkeypatch, answer)
    assert ih.read_from_file() is None
    assert message in capsys.readouterr().out


def test_an_empty_file(tmp_path, monkeypatch, capsys):
    empty = tmp_path / "empty.md"
    empty.write_text("   \n", encoding="utf-8")
    _typed(monkeypatch, str(empty))
    assert ih.read_from_file() is None
    assert "File is empty." in capsys.readouterr().out


def test_a_file_that_is_not_text(tmp_path, monkeypatch, capsys):
    binary = tmp_path / "image.png"
    binary.write_bytes(b"\x89PNG\xff\xfe\x00")
    _typed(monkeypatch, str(binary))
    assert ih.read_from_file() is None
    assert "Error reading file:" in capsys.readouterr().out


def test_a_folder_cannot_be_read(tmp_path, monkeypatch, capsys):
    _typed(monkeypatch, str(tmp_path))
    assert ih.read_from_file() is None
    out = capsys.readouterr().out
    assert "Error reading file:" in out or "Permission denied" in out


def test_an_unreadable_file(tmp_path, monkeypatch, capsys):
    secret = tmp_path / "locked.md"
    secret.write_text("x", encoding="utf-8")
    real_read = ih.Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "locked.md":
            raise PermissionError(self)
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(ih.Path, "read_text", read_text)
    _typed(monkeypatch, str(secret))
    assert ih.read_from_file() is None
    assert "Permission denied: cannot read" in capsys.readouterr().out


def test_typed_lines_end_at_the_first_empty_one(monkeypatch, capsys):
    _typed(monkeypatch, "first", "  second", "", "never read")
    assert ih.read_multiline_input("Your instructions") == "first\n  second"
    assert "Your instructions" in capsys.readouterr().out


def test_end_of_input_keeps_what_was_typed(monkeypatch):
    _typed(monkeypatch, "only line", EOFError())
    assert ih.read_multiline_input("p") == "only line"


def test_ctrl_c_cancels_the_typing(monkeypatch, capsys):
    _typed(monkeypatch, "draft", KeyboardInterrupt())
    assert ih.read_multiline_input("p") is None
    assert "Cancelled." in capsys.readouterr().out

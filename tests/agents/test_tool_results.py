"""agents.tool_results: a tool's result in the console and the activity feed."""

from __future__ import annotations

from typing import Any

from agents.tool_results import show_tool_result


class _Feed:
    def __init__(self) -> None:
        self.ends: list[dict[str, Any]] = []

    def tool_end(self, tool: str, **kwargs: Any) -> None:
        self.ends.append({"tool": tool, **kwargs})


def test_a_blocked_command_is_shown_as_blocked(capsys):
    feed = _Feed()
    show_tool_result(
        feed, "Bash", "Command blocked by hook", True, verbose=False, phase="p"
    )
    assert "[BLOCKED]" in capsys.readouterr().out
    assert feed.ends == [
        {
            "tool": "Bash",
            "success": False,
            "result": "BLOCKED",
            "detail": "Command blocked by hook",
            "phase": "p",
        }
    ]


def test_an_error_closes_the_entry_as_failed(capsys):
    feed = _Feed()
    text = "boom " * 200
    show_tool_result(feed, "Read", text, True, verbose=False, phase="p")
    assert "[Error] boom" in capsys.readouterr().out
    (end,) = feed.ends
    assert end["success"] is False
    assert end["result"] == text[:100]
    assert end["detail"] == text


def test_an_error_without_a_feed_is_only_printed(capsys):
    show_tool_result(None, "Read", "nope", True, verbose=False, phase="p")
    assert "[Error] nope" in capsys.readouterr().out


def test_a_success_keeps_the_detail_of_reading_tools_only(capsys):
    feed = _Feed()
    show_tool_result(feed, "Read", "contents", False, verbose=True, phase="p")
    show_tool_result(feed, "Glob", "a\nb", False, verbose=False, phase="p")
    out = capsys.readouterr().out
    assert "[Done] contents" in out
    assert feed.ends[0]["detail"] == "contents"
    assert feed.ends[1]["detail"] is None

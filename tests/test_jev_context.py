import pytest
from integrations.jev.context import JevContextError, select_state


def test_secret_diff_is_excluded_and_known_values_removed():
    diff = "diff --git a/.env b/.env\n+TOKEN=private-token\ndiff --git a/app.py b/app.py\n+answer = 42\n"
    state = select_state(
        request="Use private-token",
        acceptance="answer",
        files=[".env", "app.py"],
        diff=diff,
        sensitive_values=("private-token",),
    )
    assert "private-token" not in str(state)
    assert "TOKEN" not in state["diff"]
    assert "answer = 42" in state["diff"]
    assert state["files"] == ["app.py"]


def test_renamed_secret_and_assignments_are_not_sent():
    state = select_state(
        request="api_key=hidden-value",
        acceptance="works",
        files=["safe.txt"],
        diff="diff --git a/.env b/safe.txt\nrename from .env\nrename to safe.txt\n+hidden-value",
    )
    assert "hidden-value" not in str(state)


def test_unicode_size_not_character_count():
    with pytest.raises(JevContextError, match="context_too_large"):
        select_state(request="é" * 40000, acceptance="ok", files=[])


def test_unparseable_diff_is_bypassed():
    with pytest.raises(JevContextError, match="missing_context"):
        select_state(
            request="review",
            acceptance="ok",
            files=[],
            diff="private arbitrary raw patch",
        )

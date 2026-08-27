"""A wiki push refused for want of a token is a message, not a traceback.

A GitHub wiki is a separate git repository and `GITHUB_TOKEN` has no write
access to it. The sync therefore clones, generates and commits successfully,
then fails on the final push with a 403 — and used to surface that as a
`CalledProcessError` stack trace, which says nothing about the one thing that
would fix it.

Two properties are pinned here:

* the 403 is recognised and explained, and an ordinary push race still is not;
* the job fails only when the sync was actually configured. Going red on every
  push to `develop` for a feature nobody enabled teaches people to ignore red
  jobs, which costs more than a stale wiki.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "wiki" / "sync_wiki.py"

# The exact stderr GitHub returns for this repository.
DENIED = (
    "remote: Permission to krovomi/WorkPilot-AI.wiki.git denied to "
    "github-actions[bot].\n"
    "fatal: unable to access 'https://github.com/krovomi/WorkPilot-AI.wiki.git/': "
    "The requested URL returned error: 403\n"
)


@pytest.fixture(scope="module")
def sw():
    spec = importlib.util.spec_from_file_location("sync_wiki", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestDenialDetection:
    def test_the_real_403_is_recognised(self, sw):
        assert sw._push_was_denied(DENIED)

    def test_a_bare_403_is_recognised(self, sw):
        assert sw._push_was_denied("The requested URL returned error: 403")

    @pytest.mark.parametrize(
        "stderr",
        [
            "! [rejected] master -> master (fetch first)",
            "! [rejected] master -> master (non-fast-forward)",
            "error: failed to push some refs",
            "",
        ],
    )
    def test_an_ordinary_push_race_is_not_a_denial(self, sw, stderr):
        """These must keep going down the pull --rebase retry path."""
        assert not sw._push_was_denied(stderr)


class TestTheExplanation:
    def test_without_a_token_it_warns_and_says_what_to_add(
        self, sw, monkeypatch, capsys
    ):
        monkeypatch.delenv("WIKI_PUSH_TOKEN", raising=False)
        sw._explain_denied_push()
        out = capsys.readouterr().out
        assert "::warning::" in out
        assert "::error::" not in out
        assert "WIKI_PUSH_TOKEN" in out
        assert "repo" in out

    def test_with_a_token_it_errors_because_that_is_unexpected(
        self, sw, monkeypatch, capsys
    ):
        monkeypatch.setenv("WIKI_PUSH_TOKEN", "ghp_example")
        sw._explain_denied_push()
        out = capsys.readouterr().out
        assert "::error::" in out
        assert "expired" in out

    def test_it_says_the_rest_of_the_run_is_fine(self, sw, monkeypatch, capsys):
        """The reader's real question: did this break anything else?"""
        monkeypatch.delenv("WIKI_PUSH_TOKEN", raising=False)
        sw._explain_denied_push()
        assert "Nothing else" in capsys.readouterr().out


class TestExitCode:
    def _run_main_with_denied_push(self, sw, monkeypatch):
        monkeypatch.setattr(sw, "has_changes", lambda _wiki: True)
        monkeypatch.setattr(
            sw, "detect_wiki_url", lambda _repo: "https://example.invalid/x.wiki.git"
        )
        monkeypatch.setattr(
            sw, "clone_or_pull_wiki", lambda *_a, **_k: Path("/tmp/wiki")
        )
        monkeypatch.setattr(sw, "configure_git", lambda *_a, **_k: None)

        def denied(*_args, **_kwargs):
            raise sw.WikiPushDenied("denied")

        monkeypatch.setattr(sw, "commit_and_push", denied)
        monkeypatch.setattr(sw, "step_inventories", lambda *_a, **_k: None)
        monkeypatch.setattr(sw.sys, "argv", ["sync_wiki.py", "--mode", "inventories"])
        return sw.main()

    def test_unconfigured_does_not_fail_the_job(self, sw, monkeypatch):
        monkeypatch.delenv("WIKI_PUSH_TOKEN", raising=False)
        assert self._run_main_with_denied_push(sw, monkeypatch) == 0

    def test_configured_but_refused_does_fail(self, sw, monkeypatch):
        """A token that is set and still refused is a real problem."""
        monkeypatch.setenv("WIKI_PUSH_TOKEN", "ghp_example")
        assert self._run_main_with_denied_push(sw, monkeypatch) == 1

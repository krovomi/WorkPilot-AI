"""Each forge's pull request body and Azure attachments when the forge answers badly.

`test_capture_hosting_sync.py` follows a sync that goes well on every forge.
These are the answers that must read as "nothing" or "refused" rather than
an exception or a wrong write: a CLI that does not start, a body that is not
JSON, an HTTP error, a network failure, an attachment URL that is not https.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from core.capture_hosting import forges
from core.capture_hosting.forges import AzureAttachments, body_for, run_cli
from core.capture_hosting.refs import PrRef, parse_pr_url

AZURE_PR = "https://dev.azure.com/org/p/_git/app/pullrequest/42"
BITBUCKET_PR = "https://bitbucket.org/ws/app/pull-requests/9"


class Response:
    def __init__(self, status: int, data: object = None, *, bad_json=False):
        self.status_code = status
        self._data = data
        self._bad_json = bad_json

    def json(self):
        if self._bad_json:
            raise ValueError("not json")
        return self._data


class Session:
    """A `requests` stand-in: one queued answer (or error) per verb."""

    def __init__(self, **answers):
        self.answers = answers
        self.calls: list[tuple[str, str, dict]] = []

    def _answer(self, verb: str, url: str, kwargs: dict):
        self.calls.append((verb, url, kwargs))
        answer = self.answers[verb]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def request(self, method, url, **kwargs):
        return self._answer(method, url, kwargs)

    def get(self, url, **kwargs):
        return self._answer("get", url, kwargs)

    def post(self, url, **kwargs):
        return self._answer("post", url, kwargs)

    def delete(self, url, **kwargs):
        return self._answer("delete", url, kwargs)


# ── The CLI forges ───────────────────────────────────────────────────────


def test_a_cli_runs_without_a_shell_and_gives_its_code_and_output(tmp_path):
    code, out = run_cli([sys.executable, "-c", "print('{}')"], tmp_path)
    assert (code, out.strip()) == (0, "{}")


@pytest.mark.parametrize(
    "error", [FileNotFoundError("gh"), subprocess.TimeoutExpired("gh", 30)]
)
def test_a_cli_that_does_not_start_or_hangs_reads_as_a_failure(
    tmp_path, monkeypatch, error
):
    def run(*args, **kwargs):
        raise error

    monkeypatch.setattr(forges.subprocess, "run", run)
    assert run_cli(["gh", "api", "x"], tmp_path) == (-1, "")


def test_an_enterprise_host_is_named_to_the_cli(tmp_path):
    calls: list[list[str]] = []
    ref = parse_pr_url("github", "https://git.acme.example/team/app/pull/3")
    body = body_for(
        ref, tmp_path, gh="gh", run=lambda a, c: calls.append(a) or (0, "{}")
    )
    assert body is not None and body.read() == ""
    assert calls[0][:4] == ["gh", "api", "--hostname", "git.acme.example"]


@pytest.mark.parametrize(
    ("answer", "expected"),
    [((0, "<html>"), None), ((0, '{"body": 3}'), None), ((0, "[]"), "")],
)
def test_a_body_the_cli_cannot_give_as_text_is_not_read(tmp_path, answer, expected):
    ref = parse_pr_url("github", "https://github.com/a/b/pull/1")
    body = body_for(ref, tmp_path, gh="gh", run=lambda a, c: answer)
    assert body.read() == expected


def test_without_a_session_the_rest_forges_have_no_body(tmp_path):
    ref = parse_pr_url("azure_devops", AZURE_PR)
    assert body_for(ref, tmp_path, azure_auth=("", "pat")) is None


def test_a_forge_without_the_credential_it_needs_has_no_body(tmp_path):
    ref = parse_pr_url("bitbucket", BITBUCKET_PR)
    assert body_for(ref, tmp_path, session=Session()) is None


# ── The REST forges ──────────────────────────────────────────────────────


def _bitbucket(session: Session, tmp_path: Path):
    ref = parse_pr_url("bitbucket", BITBUCKET_PR)
    return body_for(
        ref, tmp_path, bitbucket_headers={"Authorization": "Bearer t"}, session=session
    )


@pytest.mark.parametrize(
    "answer",
    [
        Response(404),
        Response(200, bad_json=True),
        Response(200, ["not", "an", "object"]),
        ConnectionError("reset"),
    ],
)
def test_a_body_the_forge_refuses_or_garbles_is_not_read(tmp_path, answer):
    assert _bitbucket(Session(GET=answer), tmp_path).read() is None


def test_a_body_written_over_a_dropped_connection_is_not_written(tmp_path):
    session = Session(GET=Response(200, {"description": None}), PUT=ConnectionError())
    body = _bitbucket(session, tmp_path)
    assert body.read() == ""
    assert body.write("new") is False


def test_a_refused_write_is_not_written_and_no_redirect_is_followed(tmp_path):
    session = Session(GET=Response(200, {"description": "x"}), PUT=Response(403))
    body = _bitbucket(session, tmp_path)
    body.read()
    assert body.write("new") is False
    assert all(kwargs["allow_redirects"] is False for _, _, kwargs in session.calls)


# ── Azure DevOps attachments ─────────────────────────────────────────────


def _attachments(session: Session) -> AzureAttachments:
    return AzureAttachments(
        parse_pr_url("azure_devops", AZURE_PR), ("", "pat"), session
    )


def test_an_attachment_already_there_is_addressed_by_its_quoted_name():
    url = _attachments(Session()).url_of("wp-capture-a b.png")
    assert url.endswith("/pullRequests/42/attachments/wp-capture-a%20b.png")


@pytest.mark.parametrize(
    "answer",
    [Response(401), Response(200, bad_json=True), Response(200, []), OSError("down")],
)
def test_attachments_that_cannot_be_listed_read_as_unknown(answer):
    assert _attachments(Session(get=answer)).names() is None


@pytest.mark.parametrize(
    "answer",
    [
        Response(500),
        Response(201, bad_json=True),
        Response(201, "not a dict"),
        Response(201, {"url": "http://plain.example/a.png"}),
        OSError("down"),
    ],
)
def test_an_upload_the_forge_refuses_has_no_address(tmp_path, answer):
    image = tmp_path / "a.png"
    image.write_bytes(b"png")
    assert _attachments(Session(post=answer)).upload("wp-capture-a.png", image) is None


def test_an_image_that_cannot_be_read_is_not_uploaded(tmp_path):
    session = Session(post=Response(201, {"url": "https://x"}))
    assert (
        _attachments(session).upload("wp-capture-a.png", tmp_path / "gone.png") is None
    )
    assert session.calls == []


def test_a_delete_over_a_dropped_connection_is_not_done():
    assert (
        _attachments(Session(delete=OSError("down"))).delete("wp-capture-a.png")
        is False
    )
    assert (
        _attachments(Session(delete=Response(404))).delete("wp-capture-a.png") is True
    )


# ── Pull request URLs ────────────────────────────────────────────────────


def test_a_url_python_cannot_split_names_no_pull_request():
    assert parse_pr_url("github", "https://[::1/a/b/pull/1") is None


def test_azure_devops_has_no_branch_images():
    ref = PrRef("azure_devops", "dev.azure.com", "org/p", "app", 1)
    with pytest.raises(ValueError, match="no branch images on azure_devops"):
        ref.image_url("workpilot-captures", "a.png")

"""The GitLab REST client the MR review talks to GitLab with.

Each call goes to ``<instance>/api/v4`` with the token in ``PRIVATE-TOKEN``,
is refused before any request when its endpoint is not a GitLab API path,
waits and retries when GitLab rate-limits it, and fails with a
``GitLabAPIError`` that carries GitLab's status. GitLab is a local HTTP
server; the project config is a real file.
"""

from __future__ import annotations

import importlib
import json
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import pytest
from runners.gitlab.glab_client import (
    GitLabAPIError,
    GitLabClient,
    GitLabConfig,
    encode_project_path,
    load_gitlab_config,
    validate_endpoint,
)


@pytest.fixture
def client(tmp_path, gitlab):
    return GitLabClient(
        tmp_path,
        GitLabConfig(
            token=gitlab.token, project=gitlab.project, instance_url=gitlab.url + "/"
        ),
    )


@pytest.fixture
def waits(monkeypatch):
    """The seconds the client sleeps between attempts, without sleeping."""
    slept: list[float] = []
    glab_client = importlib.import_module("runners.gitlab.glab_client")
    monkeypatch.setattr(glab_client.time, "sleep", slept.append)
    return slept


class TestReading:
    def test_an_mr_its_changes_and_its_commits(self, client, gitlab):
        mr = f"{gitlab.api}/merge_requests/4"
        gitlab.answer("GET", mr, gitlab.Answer(body={"iid": 4}))
        gitlab.answer(
            "GET",
            f"{mr}/changes",
            gitlab.Answer(
                body={"changes": [{"diff": "+a"}, {"diff": ""}, {"diff": "-b"}]}
            ),
        )
        gitlab.answer("GET", f"{mr}/commits", gitlab.Answer(body=[{"id": "c1"}]))

        assert client.get_mr(4) == {"iid": 4}
        assert client.get_mr_diff(4) == "+a\n-b"
        assert client.get_mr_commits(4) == [{"id": "c1"}]
        assert gitlab.requests[0].headers["private-token"] == gitlab.token

    def test_the_signed_in_user(self, client, gitlab):
        gitlab.answer("GET", "/api/v4/user", gitlab.Answer(body={"username": "ann"}))

        assert client.get_current_user() == {"username": "ann"}


class TestWriting:
    def test_a_note_is_posted_on_the_mr(self, client, gitlab):
        gitlab.answer(
            "POST",
            f"{gitlab.api}/merge_requests/4/notes",
            gitlab.Answer(201, {"id": 9}),
        )

        assert client.post_mr_note(4, "Looks good") == {"id": 9}
        assert gitlab.requests[0].body == {"body": "Looks good"}

    def test_an_approval_sends_no_body(self, client, gitlab):
        gitlab.answer(
            "POST", f"{gitlab.api}/merge_requests/4/approve", gitlab.Answer(201, {})
        )

        client.approve_mr(4)

        assert gitlab.requests[0].body is None

    @pytest.mark.parametrize(
        ("squash", "body"), [(False, None), (True, {"squash": True})]
    )
    def test_a_merge_asks_for_a_squash_only_when_wanted(
        self, client, gitlab, squash, body
    ):
        gitlab.answer(
            "PUT",
            f"{gitlab.api}/merge_requests/4/merge",
            gitlab.Answer(body={"state": "merged"}),
        )

        assert client.merge_mr(4, squash=squash) == {"state": "merged"}
        assert gitlab.requests[0].body == body

    def test_assignees_are_set(self, client, gitlab):
        gitlab.answer("PUT", f"{gitlab.api}/merge_requests/4", gitlab.Answer(body={}))

        client.assign_mr(4, [11, 12])

        assert gitlab.requests[0].body == {"assignee_ids": [11, 12]}

    def test_an_empty_answer_is_none(self, client, gitlab):
        gitlab.answer("PUT", f"{gitlab.api}/merge_requests/4", gitlab.Answer(204))

        assert client.assign_mr(4, []) is None


class TestFailures:
    def test_a_refusal_carries_gitlabs_status_and_message(self, client, gitlab):
        gitlab.answer(
            "GET",
            f"{gitlab.api}/merge_requests/4",
            gitlab.Answer(403, {"message": "403 Forbidden"}),
        )

        with pytest.raises(GitLabAPIError) as refused:
            client.get_mr(4)

        assert refused.value.status == 403
        assert (
            str(refused.value) == 'GitLab API error 403: {"message": "403 Forbidden"}'
        )
        assert len(gitlab.requests) == 1

    def test_an_answer_that_is_not_json_raises(self, client, gitlab):
        gitlab.answer("GET", "/api/v4/user", gitlab.Answer(raw=b"<html>"))

        with pytest.raises(json.JSONDecodeError):
            client.get_current_user()


class TestRateLimits:
    def path(self, gitlab):
        return f"{gitlab.api}/merge_requests/4"

    def limited(self, gitlab, retry_after: str | None = None):
        headers = {"Retry-After": retry_after} if retry_after is not None else {}
        return gitlab.Answer(429, {"message": "slow down"}, headers=headers)

    def test_it_waits_as_told_and_tries_again(self, client, gitlab, waits, capsys):
        gitlab.answer(
            "GET",
            self.path(gitlab),
            self.limited(gitlab, "7"),
            gitlab.Answer(body={"iid": 4}),
        )

        assert client.get_mr(4) == {"iid": 4}
        assert waits == [7]
        assert (
            "Rate limited (429). Retrying in 7s (attempt 1/3)"
            in capsys.readouterr().out
        )

    def test_without_a_retry_after_the_wait_doubles(self, client, gitlab, waits):
        gitlab.answer("GET", self.path(gitlab), self.limited(gitlab))

        with pytest.raises(GitLabAPIError) as refused:
            client.get_mr(4)

        assert refused.value.status == 429
        assert waits == [1, 2]
        assert len(gitlab.requests) == 3

    def test_a_retry_after_date_is_waited_until(self, client, gitlab, waits):
        later = format_datetime(datetime.now(UTC) + timedelta(seconds=90), usegmt=True)
        gitlab.answer(
            "GET",
            self.path(gitlab),
            self.limited(gitlab, later),
            gitlab.Answer(body={}),
        )

        client.get_mr(4)

        assert 80 <= waits[0] <= 90

    def test_a_retry_after_date_in_the_past_still_waits_a_second(
        self, client, gitlab, waits
    ):
        gone = format_datetime(datetime.now(UTC) - timedelta(hours=1), usegmt=True)
        gitlab.answer(
            "GET", self.path(gitlab), self.limited(gitlab, gone), gitlab.Answer(body={})
        )

        client.get_mr(4)

        assert waits == [1]

    @pytest.mark.parametrize("value", ["soon", "Wed, 21 Oct 2015 07:28:00"])
    def test_an_unreadable_retry_after_falls_back_to_doubling(
        self, client, gitlab, waits, value
    ):
        gitlab.answer(
            "GET",
            self.path(gitlab),
            self.limited(gitlab, value),
            gitlab.Answer(body={}),
        )

        client.get_mr(4)

        assert waits == [1]

    def test_a_negative_retry_after_does_not_break_the_wait(
        self, client, gitlab, waits
    ):
        gitlab.answer(
            "GET", self.path(gitlab), self.limited(gitlab, "-5"), gitlab.Answer(body={})
        )

        client.get_mr(4)

        assert waits == [0]

    def test_one_attempt_is_always_made(self, client, gitlab, waits):
        gitlab.answer("GET", self.path(gitlab), self.limited(gitlab, "0"))

        with pytest.raises(GitLabAPIError):
            client._fetch(self.path(gitlab).removeprefix("/api/v4"), max_retries=0)

        assert len(gitlab.requests) == 1
        assert waits == []


class TestEndpoints:
    @pytest.mark.parametrize(
        ("endpoint", "reason"),
        [
            ("", "cannot be empty"),
            ("projects/1", "must start with /"),
            ("/projects/../admin", "path traversal"),
            ("/projects/1\x00", "null byte"),
            ("/admin/users", "does not match known GitLab API patterns"),
        ],
    )
    def test_a_path_that_is_not_a_gitlab_api_path_is_refused(self, endpoint, reason):
        with pytest.raises(ValueError, match=reason):
            validate_endpoint(endpoint)

    def test_the_known_api_paths_are_accepted(self):
        for endpoint in ("/projects/1", "/user", "/users/2", "/groups/g", "/issues/3"):
            validate_endpoint(endpoint)

    def test_a_project_path_is_sent_as_one_encoded_segment(self):
        assert encode_project_path("group/sub group/app") == "group%2Fsub%20group%2Fapp"

    def test_a_project_named_with_dots_cannot_climb_out_of_its_path(
        self, tmp_path, gitlab
    ):
        client = GitLabClient(
            tmp_path,
            GitLabConfig(token="t", project="../../admin", instance_url=gitlab.url),
        )

        with pytest.raises(ValueError, match="path traversal"):
            client.get_mr(1)

        assert gitlab.requests == []


class TestTheProjectConfig:
    def write(self, project, data) -> None:
        folder = project / ".workpilot" / "gitlab"
        folder.mkdir(parents=True)
        text = data if isinstance(data, str) else json.dumps(data)
        (folder / "config.json").write_text(text, encoding="utf-8")

    def test_it_is_read_from_the_project(self, tmp_path):
        self.write(
            tmp_path,
            {"token": "t0k", "project": "g/a", "instance_url": "https://git.corp"},
        )

        assert load_gitlab_config(tmp_path) == GitLabConfig(
            "t0k", "g/a", "https://git.corp"
        )

    def test_the_instance_defaults_to_gitlab_com(self, tmp_path):
        self.write(tmp_path, {"token": "t0k", "project": "g/a"})

        assert load_gitlab_config(tmp_path).instance_url == "https://gitlab.com"

    @pytest.mark.parametrize(
        "data", [{"project": "g/a"}, {"token": "t0k"}, "{broken"], ids=str
    )
    def test_an_incomplete_or_broken_config_is_none(self, tmp_path, data):
        self.write(tmp_path, data)

        assert load_gitlab_config(tmp_path) is None

    def test_a_project_without_a_config_is_none(self, tmp_path):
        assert load_gitlab_config(tmp_path) is None

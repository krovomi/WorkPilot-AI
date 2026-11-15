"""The Jira connector against a local HTTP server that answers like Jira Cloud.

The desktop app imports ``JiraClient`` and ``JiraConnector`` from a Python
child process (``jira-handlers.ts``); these tests drive the same objects over
real HTTP, so the requests Jira would see (path, query, body, auth) are what is
asserted, not calls on a mock.
"""

from __future__ import annotations

import base64
from typing import Any

import pytest
import requests

import src.connectors.jira as jira_package
from src.connectors.jira.client import JiraClient
from src.connectors.jira.connector import JiraConnector
from src.connectors.jira.exceptions import (
    JiraAPIError,
    JiraConfigurationError,
    JiraIssueNotFoundError,
)
from src.connectors.jira.models import JiraComment, JiraIssue, JiraStatus

EMAIL = "ada@example.com"
TOKEN = "jira-token"


@pytest.fixture
def jira(fake_api):
    fake_api.answer("GET", "/rest/api/3/myself", {"accountId": "me"})
    return fake_api


@pytest.fixture
def client(jira) -> JiraClient:
    built = JiraClient(base_url=jira.url, email=EMAIL, token=TOKEN)
    built.connect()
    return built


@pytest.fixture
def connector(client: JiraClient) -> JiraConnector:
    return JiraConnector(client)


def _issue(key: str, **fields: Any) -> dict[str, Any]:
    base = {
        "summary": f"Summary of {key}",
        "status": {"name": "To Do", "id": "1", "statusCategory": {"key": "new"}},
        "issuetype": {"name": "Story"},
        "project": {"key": key.split("-")[0]},
    }
    base.update(fields)
    return {"id": "100", "key": key, "fields": base}


# ── JiraClient ───────────────────────────────────────────────────────


class TestClient:
    def test_connect_sends_basic_auth(self, jira, client):
        expected = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
        assert jira.last("GET", "/rest/api/3/myself")["auth"] == f"Basic {expected}"
        assert client.get_connection_info() == {
            "base_url": jira.url,
            "email": EMAIL,
            "connected": "True",
        }

    def test_from_env_connects(self, jira, monkeypatch):
        monkeypatch.setenv("JIRA_URL", jira.url)
        monkeypatch.setenv("JIRA_EMAIL", EMAIL)
        monkeypatch.setenv("JIRA_API_TOKEN", TOKEN)

        assert JiraClient.from_env().is_connected
        assert JiraConnector.from_env().is_connected

    def test_a_request_error_while_connecting(self, monkeypatch):
        def broken(*_a, **_k):
            raise requests.exceptions.Timeout("too slow")

        monkeypatch.setattr(requests.Session, "get", broken)
        built = JiraClient(base_url="https://x.atlassian.net", email=EMAIL, token=TOKEN)

        with pytest.raises(JiraAPIError, match="Failed to connect to Jira: too slow"):
            built.connect()
        assert not built.is_connected

    def test_get_with_an_empty_body_is_an_empty_dict(self, jira, client):
        jira.answer("GET", "/rest/api/3/empty", None, status=204)

        assert client.get("/rest/api/3/empty") == {}

    def test_post_and_put_send_json(self, jira, client):
        jira.answer("POST", "/rest/api/3/thing", {"id": 1})
        jira.answer("PUT", "/rest/api/3/thing", None, status=204)
        jira.answer("POST", "/rest/api/3/quiet", None, status=204)
        jira.answer("PUT", "/rest/api/3/other", {"ok": True})

        assert client.post("/rest/api/3/thing", {"a": 1}) == {"id": 1}
        assert client.put("/rest/api/3/thing", {"b": 2}) == {}
        assert client.post("/rest/api/3/quiet") == {}
        assert client.put("/rest/api/3/other") == {"ok": True}
        assert jira.last("POST", "/rest/api/3/thing")["json"] == {"a": 1}
        assert jira.last("PUT", "/rest/api/3/thing")["json"] == {"b": 2}

    @pytest.mark.parametrize("method", ["get", "post", "put"])
    def test_a_transport_failure_names_the_endpoint(self, client, monkeypatch, method):
        def broken(*_a, **_k):
            raise requests.exceptions.ConnectionError("reset")

        monkeypatch.setattr(client._session, method, broken)

        with pytest.raises(JiraAPIError, match="Request to /rest/api/3/x failed"):
            getattr(client, method)("/rest/api/3/x")

    @pytest.mark.parametrize("method", ["get", "post", "put"])
    def test_calls_before_connect_are_refused(self, method):
        built = JiraClient(base_url="https://x.atlassian.net", email=EMAIL, token=TOKEN)

        with pytest.raises(JiraConfigurationError, match="Call connect"):
            getattr(built, method)("/rest/api/3/x")

    def test_a_404_elsewhere_is_an_api_error(self, client):
        with pytest.raises(JiraAPIError) as caught:
            client.get("/rest/api/3/field")
        assert caught.value.status_code == 404

    def test_a_404_on_an_issue_names_it(self, client):
        with pytest.raises(JiraIssueNotFoundError, match="PROJ-9"):
            client.get("/rest/api/3/issue/PROJ-9")

    def test_error_messages_and_field_errors_are_joined(self, jira, client):
        jira.answer(
            "POST",
            "/rest/api/3/issue",
            {"errorMessages": ["Bad request"], "errors": {"summary": "required"}},
            status=400,
        )

        with pytest.raises(JiraAPIError, match="Bad request; summary: required"):
            client.post("/rest/api/3/issue", {})

    def test_a_non_json_error_body_is_quoted(self, jira, client):
        jira.answer_raw("GET", "/rest/api/3/boom", b"<html>Gateway</html>", 502)

        with pytest.raises(JiraAPIError, match="<html>Gateway</html>") as caught:
            client.get("/rest/api/3/boom")
        assert caught.value.status_code == 502

    def test_disconnect_twice(self, client):
        client.disconnect()
        client.disconnect()
        assert not client.is_connected


# ── JiraConnector ────────────────────────────────────────────────────


class TestAcceptanceCriteria:
    def test_the_field_is_found_by_name_and_requested(self, jira, connector):
        jira.answer(
            "GET",
            "/rest/api/3/field",
            [
                {"id": "summary", "name": "Summary"},
                {"id": "customfield_10042", "name": "Critères d'acceptation"},
            ],
        )
        jira.answer(
            "GET",
            "/rest/api/3/search/jql",
            {
                "issues": [
                    _issue(
                        "PROJ-1",
                        customfield_10042={
                            "type": "doc",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [{"type": "text", "text": "Given X"}],
                                }
                            ],
                        },
                    ),
                    _issue("PROJ-2", customfield_10042="  Then Y  "),
                    _issue("PROJ-3"),
                ]
            },
        )

        issues = connector.search_issues("PROJ")

        assert [i.acceptance_criteria for i in issues] == ["Given X", "Then Y", ""]
        fields = jira.last("GET", "/rest/api/3/search/jql")["query"]["fields"]
        assert fields.split(",")[-1] == "customfield_10042"

        # The lookup is made once per connector.
        connector.search_issues("PROJ")
        assert [r["path"] for r in jira.seen].count("/rest/api/3/field") == 1

    def test_a_field_with_only_a_key(self, jira, connector):
        jira.answer(
            "GET",
            "/rest/api/3/field",
            [{"key": "customfield_10050", "name": "Acceptance Criteria"}],
        )
        jira.answer(
            "GET",
            "/rest/api/3/issue/PROJ-4",
            _issue("PROJ-4", customfield_10050="Done"),
        )

        assert connector.get_issue("PROJ-4").acceptance_criteria == "Done"

    def test_no_such_field_leaves_criteria_empty(self, jira, connector):
        jira.answer("GET", "/rest/api/3/field", [{"id": "x", "name": "Story points"}])
        jira.answer("GET", "/rest/api/3/issue/PROJ-5", _issue("PROJ-5"))

        assert connector.get_issue("PROJ-5").acceptance_criteria == ""

    def test_a_field_list_that_is_not_a_list(self, jira, connector):
        jira.answer("GET", "/rest/api/3/field", {"unexpected": True})
        jira.answer("GET", "/rest/api/3/issue/PROJ-6", _issue("PROJ-6"))

        assert connector.get_issue("PROJ-6").acceptance_criteria == ""

    def test_a_failing_field_list_is_not_fatal(self, jira, connector):
        jira.answer("GET", "/rest/api/3/field", {"errorMessages": ["no"]}, 500)
        jira.answer("GET", "/rest/api/3/issue/PROJ-7", _issue("PROJ-7"))

        assert connector.get_issue("PROJ-7").key == "PROJ-7"


class TestIssues:
    def test_create_issue_with_every_option(self, jira, connector):
        jira.answer("GET", "/rest/api/3/field", [])
        jira.answer("POST", "/rest/api/3/issue", {"key": "PROJ-8"})
        jira.answer("GET", "/rest/api/3/issue/PROJ-8", _issue("PROJ-8"))

        issue = connector.create_issue(
            "PROJ",
            "Login fails",
            issue_type="Bug",
            description="Steps",
            priority="High",
            labels=["qa"],
            assignee_account_id="acc-1",
            custom_fields={"customfield_1": "v"},
        )

        assert issue.key == "PROJ-8"
        sent = jira.last("POST", "/rest/api/3/issue")["json"]["fields"]
        assert sent["assignee"] == {"accountId": "acc-1"}
        assert sent["customfield_1"] == "v"
        assert sent["priority"] == {"name": "High"}
        assert sent["labels"] == ["qa"]

    def test_update_issue_puts_the_fields(self, jira, connector):
        jira.answer("PUT", "/rest/api/3/issue/PROJ-8", None, status=204)

        connector.update_issue("PROJ-8", {"summary": "New"})

        assert jira.last("PUT", "/rest/api/3/issue/PROJ-8")["json"] == {
            "fields": {"summary": "New"}
        }

    def test_add_comment_sends_adf_and_reads_it_back(self, jira, connector):
        jira.answer(
            "POST",
            "/rest/api/3/issue/PROJ-8/comment",
            {
                "id": "9",
                "body": {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "Hi"}],
                        }
                    ],
                },
                "author": {"accountId": "a", "displayName": "Ada"},
                "created": "2026-11-14T10:00:00.000+0000",
            },
        )

        comment = connector.add_comment("PROJ-8", "Hi")

        assert comment.comment_id == "9"
        assert comment.body == "Hi"
        assert comment.author.display_name == "Ada"
        sent = jira.last("POST", "/rest/api/3/issue/PROJ-8/comment")["json"]
        assert sent["body"]["content"][0]["content"][0]["text"] == "Hi"

    def test_connection_lifecycle(self, jira, connector):
        assert connector.is_connected
        assert connector.get_connection_info()["base_url"] == jira.url
        connector.disconnect()
        assert not connector.is_connected
        connector.connect()
        assert connector.is_connected


class TestModels:
    def test_unreadable_dates_are_dropped(self):
        issue = JiraIssue.from_api_response(
            _issue("PROJ-1", created="yesterday", updated="soon")
        )

        assert issue.created is None
        assert issue.updated is None

    def test_a_missing_status_is_unknown(self):
        assert JiraStatus.from_api_response(None).name == "Unknown"

    def test_comment_with_plain_body_and_bad_date(self):
        comment = JiraComment.from_api_response(
            {"id": 3, "body": "plain", "created": "not a date"}
        )

        assert comment.comment_id == "3"
        assert comment.body == "plain"
        assert comment.created is None
        assert comment.author is None

    def test_the_package_exports_what_the_app_imports(self):
        assert jira_package.JiraConnector is JiraConnector
        assert jira_package.JiraClient is JiraClient
        assert "JiraWorkItemsClient" not in jira_package.__all__

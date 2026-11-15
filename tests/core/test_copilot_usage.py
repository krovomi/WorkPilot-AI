"""What the Copilot usage gauge reads, through a stand-in `gh` on the PATH.

The app asks `/providers/usage/copilot`; the backend asks `gh` for the
personal quotas first (`/copilot_internal/user`, no admin right needed), then
for the enterprise and organisation reports, which only an admin can read.
`gh` here is a small program that answers chosen commands (`tests/gh_fake.py`);
the report download is the only network call, and its stand-in is the
`requests.get` the connector would make.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import socket
import sys
from pathlib import Path

import pytest
import requests
from core import copilot_usage
from core.copilot_usage import (
    CopilotUsageConnector,
    _is_safe_report_url,
    get_copilot_usage_metrics,
)

# Loaded by path: tests/ on sys.path would let a test folder shadow a backend package.
_spec = importlib.util.spec_from_file_location(
    "copilot_usage_gh_fake", Path(__file__).resolve().parents[1] / "gh_fake.py"
)
_gh_fake = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _gh_fake
_spec.loader.exec_module(_gh_fake)
write_fake_gh = _gh_fake.write_fake_gh

QUOTAS = "api /copilot_internal/user"
LOGIN = "api user --jq .login"
ENTERPRISES = "api user/enterprises --jq .[].slug"
ORGS = "api user/orgs --jq .[].login"
REPORT_URL = "https://reports.example.test/copilot/day.json"
PUBLIC_ADDRESS = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("140.82.112.3", 443))]


def enterprise_report(slug: str) -> str:
    return f"api /enterprises/{slug}/copilot/metrics/reports/enterprise-1-day"


def org_report(org: str) -> str:
    return f"api /orgs/{org}/copilot/metrics/reports/organization-1-day"


def ok(stdout: object) -> dict:
    return {"stdout": stdout if isinstance(stdout, str) else json.dumps(stdout)}


def fails(stderr: str) -> dict:
    return {"stderr": stderr, "code": 1}


NO_QUOTAS = {QUOTAS: fails("HTTP 404: Not Found (copilot_internal/user)")}


@pytest.fixture
def gh(tmp_path, monkeypatch):
    fake = write_fake_gh(tmp_path / "bin", {})
    monkeypatch.setenv("PATH", str(fake.directory))
    return fake


class Report:
    """The response `requests.get` gives for a signed report URL."""

    def __init__(self, body: object, status: int = 200) -> None:
        self.text = body if isinstance(body, str) else json.dumps(body)
        self.status = status

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise requests.HTTPError(f"{self.status} Client Error")

    def json(self) -> object:
        return json.loads(self.text)


@pytest.fixture
def reports(monkeypatch):
    """Report URLs resolve to a public address and answer what the test set."""
    served: dict[str, Report] = {}
    asked: list[tuple[str, dict]] = []

    def get(url, **kwargs):
        asked.append((url, kwargs))
        return served[url]

    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: PUBLIC_ADDRESS)
    monkeypatch.setattr(requests, "get", get)
    return served, asked


def usage_route() -> dict:
    from provider_api import get_provider_usage

    return asyncio.run(get_provider_usage("copilot"))


class TestPersonalQuotas:
    def test_the_gauge_shows_the_premium_requests_left(self, gh):
        gh.answer(
            {
                QUOTAS: ok(
                    {
                        "login": "dana",
                        "copilot_plan": "business",
                        "organization_list": [{"login": "acme"}],
                        "quota_reset_date": "2026-12-01",
                        "quota_snapshots": {
                            "premium_interactions": {
                                "entitlement": 300,
                                "remaining": 120,
                                "percent_remaining": 40.0,
                                "overage_count": 2,
                            },
                            "chat": {"unlimited": True},
                            "completions": {"unlimited": True, "remaining": None},
                        },
                    }
                )
            }
        )

        answer = usage_route()

        assert answer["available"] is True
        assert answer["usage"]["scope"] == "personal-quotas"
        assert answer["usage"]["organization"] == "acme"
        details = answer["copilotUsageDetails"]
        assert details["plan"] == "business"
        assert details["premiumRequestsUsed"] == 180
        assert details["premiumRequestsRemaining"] == 120
        assert details["premiumRequestsPercentUsed"] == 60.0
        assert details["chatUnlimited"] is True
        assert details["quotaResetDate"] == "2026-12-01"
        assert gh.calls() == [["api", "/copilot_internal/user"]]

    def test_a_seat_without_snapshots_reads_as_nothing_used(self, gh):
        gh.answer(
            {
                QUOTAS: ok(
                    {
                        "quota_snapshots": None,
                        "organization_list": ["not-a-dict"],
                        "quota_reset_date_utc": "2026-12-01T00:00:00Z",
                    }
                )
            }
        )

        quotas = CopilotUsageConnector().get_copilot_personal_quotas()

        assert quotas["organization"] is None
        assert quotas["premium_requests"]["used"] == 0
        assert quotas["premium_requests"]["percent_used"] == 0.0
        assert quotas["premium_requests"]["percent_remaining"] is None
        assert quotas["quota_reset_date"] == "2026-12-01T00:00:00Z"

    def test_an_org_named_by_its_name_is_shown_by_it(self, gh):
        gh.answer({QUOTAS: ok({"organization_list": [{"name": "Acme Inc"}]})})

        quotas = CopilotUsageConnector().get_copilot_personal_quotas()

        assert quotas["organization"] == "Acme Inc"

    def test_an_answer_that_is_not_json_says_the_usage_could_not_be_read(self, gh):
        gh.answer({QUOTAS: ok("<html>sign in</html>")})

        usage = get_copilot_usage_metrics()

        assert usage["error"] == "COPILOT_USAGE_RETRIEVAL_FAILED"
        assert usage["available"] is False
        answer = usage_route()
        assert answer == {
            "provider": "copilot",
            "available": False,
            "error": "COPILOT_USAGE_RETRIEVAL_FAILED",
            "message": usage["message"],
        }


class TestEnterpriseReport:
    def test_without_a_seat_an_enterprise_admin_sees_the_day_report(self, gh, reports):
        served, asked = reports
        served[REPORT_URL] = Report(
            {
                "usage": [
                    {
                        "total_suggestions": 80,
                        "total_acceptances": 20,
                        "total_lines_suggested": 400,
                        "total_lines_accepted": 100,
                    },
                    "a line that is not a day",
                ]
            }
        )
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana\n"),
                ENTERPRISES: ok("\nempty-co\nacme\n"),
                enterprise_report("empty-co"): ok(""),
                enterprise_report("acme"): ok({"download_links": [REPORT_URL]}),
            }
        )

        answer = usage_route()

        assert answer["available"] is True
        assert answer["usage"]["level"] == "enterprise"
        assert answer["usage"]["organization"] == "acme"
        details = answer["copilotUsageDetails"]
        assert details["scope"] == "aggregated-metrics"
        assert details["suggestions"] == 80
        assert details["acceptanceRate"] == 25.0
        assert details["lineAcceptanceRate"] == 25.0
        # The signed URL is fetched once, and a redirect is not followed.
        assert asked == [(REPORT_URL, {"timeout": 30, "allow_redirects": False})]
        day = gh.calls()[-1]
        assert day[:2] == ["api", enterprise_report("acme").split()[1]]
        assert day[-2] == "-f" and day[-1].startswith("day=")

    def test_a_report_in_another_format_is_still_read_as_json(self, gh, reports):
        served, _ = reports
        url = "https://reports.example.test/copilot/day"
        served[url] = Report({"data": {"total_suggestions": 10}})
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana"),
                ENTERPRISES: ok("acme"),
                enterprise_report("acme"): ok({"download_links": [url]}),
            }
        )

        usage = CopilotUsageConnector().get_copilot_usage_summary()

        assert usage["total_suggestions"] == 10
        assert usage["acceptance_rate_percent"] == 0
        assert usage["line_acceptance_rate_percent"] == 0


class TestOrganizationReport:
    def test_an_org_admin_gets_the_org_report_when_no_enterprise_has_one(
        self, gh, reports
    ):
        served, _ = reports
        served[REPORT_URL] = Report({"total_suggestions": 5, "total_acceptances": 5})
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana"),
                ENTERPRISES: ok("acme\nbeta"),
                enterprise_report("acme"): ok({"download_links": []}),
                enterprise_report("beta"): fails("HTTP 403: Forbidden"),
                ORGS: ok("quiet\nshop"),
                org_report("quiet"): ok({"download_links": []}),
                org_report("shop"): ok({"download_links": [REPORT_URL]}),
            }
        )

        usage = CopilotUsageConnector().get_copilot_usage_summary()

        assert usage["level"] == "organization"
        assert usage["organization"] == "shop"
        assert usage["acceptance_rate_percent"] == 100.0

    def test_a_user_in_no_enterprise_falls_back_to_the_orgs(self, gh, reports):
        served, _ = reports
        served[REPORT_URL] = Report({"total_suggestions": 1})
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana"),
                ENTERPRISES: ok(""),
                ORGS: ok("shop"),
                org_report("shop"): ok({"download_links": [REPORT_URL]}),
            }
        )

        usage = CopilotUsageConnector().get_copilot_usage_summary()

        assert usage["organization"] == "shop"

    def test_without_admin_org_the_gauge_says_which_scope_to_add(self, gh):
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana"),
                ENTERPRISES: ok(""),
                ORGS: ok("shop\nlab\nbroken"),
                org_report("shop"): fails("HTTP 403: needs the admin:org scope"),
                org_report("lab"): fails("HTTP 404: Not Found"),
                org_report("broken"): fails("HTTP 500: Server Error"),
            }
        )

        usage = get_copilot_usage_metrics()

        assert usage["error"] == "INSUFFICIENT_PERMISSIONS"
        assert usage["permission_required"] == "admin:org"
        assert any(
            "gh auth refresh -h github.com -s admin:org" in step
            for step in usage["suggestions"]
        )

    def test_orgs_that_have_no_report_say_it_is_unavailable(self, gh):
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: ok("dana"),
                ENTERPRISES: ok(""),
                ORGS: ok("lab\nbroken\nempty"),
                org_report("lab"): fails("HTTP 404: Not Found"),
                org_report("broken"): fails("HTTP 500: Server Error"),
                org_report("empty"): ok(""),
            }
        )

        usage = get_copilot_usage_metrics()

        assert usage["error"] == "COPILOT_USAGE_UNAVAILABLE"
        assert usage["available"] is False

    def test_a_user_in_no_org_is_told_it_is_unavailable(self, gh):
        gh.answer({**NO_QUOTAS, LOGIN: ok("dana"), ENTERPRISES: ok(""), ORGS: ok("")})

        usage = get_copilot_usage_metrics()

        assert usage["error"] == "COPILOT_USAGE_UNAVAILABLE"

    def test_a_user_that_is_not_logged_in_is_asked_to_log_in(self, gh, caplog):
        gh.answer(
            {
                **NO_QUOTAS,
                LOGIN: fails("You are not logged into any GitHub hosts."),
                ORGS: fails("You are not logged into any GitHub hosts."),
            }
        )

        with caplog.at_level("WARNING", logger=copilot_usage.__name__):
            usage = get_copilot_usage_metrics()

        assert usage["error"] == "COPILOT_USAGE_UNAVAILABLE"
        assert "GitHub CLI not authenticated. Run 'gh auth login'" in caplog.text

    def test_a_login_failure_other_than_auth_is_passed_on(self, gh):
        gh.answer({LOGIN: fails("HTTP 502: Bad Gateway")})

        with pytest.raises(RuntimeError, match="HTTP 502"):
            CopilotUsageConnector()._get_authenticated_user()


class TestGhItself:
    def test_without_gh_the_message_says_where_to_install_it(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("PATH", str(tmp_path))

        connector = CopilotUsageConnector()

        assert connector.gh_executable == "gh"
        with pytest.raises(RuntimeError, match="https://cli.github.com/"):
            connector._run_gh_command(["api", "user"])

    def test_a_gh_that_hangs_is_given_up_on(self, gh):
        with pytest.raises(RuntimeError, match="timed out after"):
            CopilotUsageConnector()._run_gh_command(["api", "user"], timeout=0.001)

    def test_a_failed_command_says_its_exit_code_and_output(self, gh):
        gh.answer({"api user": {"stdout": "partial", "stderr": "boom", "code": 4}})

        with pytest.raises(RuntimeError) as failure:
            CopilotUsageConnector()._run_gh_command(["api", "user"])

        assert "Exit code: 4" in str(failure.value)
        assert "stderr: boom" in str(failure.value)
        assert "stdout: partial" in str(failure.value)


class TestReportDownload:
    """A signed report URL is fetched only if it is https to a public address."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://reports.example.test/day.json",
            "https:///day.json",
            "https://[",
            "https://127.0.0.1/day.json",
            "https://10.0.0.8/day.json",
            "https://169.254.169.254/latest/meta-data",
        ],
    )
    def test_an_unsafe_url_is_refused(self, url):
        assert _is_safe_report_url(url) is False

    def test_a_host_that_does_not_resolve_is_refused(self, monkeypatch):
        def no_such_host(host, port):
            raise socket.gaierror("Name or service not known")

        monkeypatch.setattr(socket, "getaddrinfo", no_such_host)

        assert _is_safe_report_url(REPORT_URL) is False

    def test_a_public_https_url_is_allowed(self, monkeypatch):
        monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: PUBLIC_ADDRESS)

        assert _is_safe_report_url(REPORT_URL) is True

    def test_a_report_pointing_at_the_metadata_service_is_not_fetched(
        self, gh, monkeypatch
    ):
        fetched: list[str] = []
        monkeypatch.setattr(requests, "get", lambda url, **_: fetched.append(url))

        with pytest.raises(RuntimeError, match="SSRF guard"):
            CopilotUsageConnector()._download_report(
                "https://169.254.169.254/latest/meta-data"
            )
        assert fetched == []

    def test_a_report_that_fails_to_download_says_so(self, gh, reports):
        served, _ = reports
        served[REPORT_URL] = Report("expired", status=403)

        with pytest.raises(RuntimeError, match="Failed to download report: 403"):
            CopilotUsageConnector()._download_report(REPORT_URL)

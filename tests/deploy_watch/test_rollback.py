"""Rollback plans per CI/CD provider (#366)."""

from __future__ import annotations

import json

import pytest
from deploy_watch.rollback import RollbackPlan, execute_rollback, plan_rollback

TRIGGERED = "2026-11-15T10:00:00.000Z"
GOOD_SHA = "a" * 40
BAD_SHA = "b" * 40

GITHUB_ENV = {
    "CICD_GITHUB_TOKEN": "gh-test-0000",
    "CICD_GITHUB_WORKFLOW": "deploy.yml",
}
RUN = {
    "id": "1",
    "provider": "github",
    "triggered_at": TRIGGERED,
    "pr_url": "https://github.com/acme/shop/pull/12",
}
GH_RUNS = "https://api.github.com/repos/acme/shop/actions/workflows/deploy.yml/runs"

AZURE_ENV = {
    "CICD_AZURE_TOKEN": "az-test-0000",
    "CICD_AZURE_ORG": "acme",
    "CICD_AZURE_PROJECT": "Shop",
    "CICD_AZURE_PIPELINE_ID": "7",
}
AZ = "https://dev.azure.com/acme/Shop/_apis/pipelines/7/runs"


def _gh_runs() -> dict:
    return {
        "workflow_runs": [
            {
                "id": 30,
                "conclusion": None,
                "created_at": "2026-11-15T10:00:05Z",
                "head_sha": BAD_SHA,
            },
            {
                "id": 20,
                "conclusion": "failure",
                "created_at": "2026-11-15T09:00:00Z",
                "head_sha": "c" * 40,
            },
            {
                "id": 10,
                "conclusion": "success",
                "created_at": "2026-11-15T08:00:00Z",
                "head_sha": GOOD_SHA,
                "html_url": "https://github.com/acme/shop/actions/runs/10",
            },
            {
                "id": 5,
                "conclusion": "success",
                "created_at": "2026-11-14T08:00:00Z",
                "head_sha": "d" * 40,
            },
            {"id": "x", "created_at": "2026-11-14T08:00:00Z"},
            {"id": 4, "created_at": "not a date"},
            "junk",
        ]
    }


class TestGithub:
    def test_plan_reruns_the_last_good_run(self, fake_fetch):
        fetch = fake_fetch({GH_RUNS: (200, _gh_runs())})
        plan = plan_rollback(GITHUB_ENV, RUN, fetch)
        assert plan == RollbackPlan(
            "github",
            "rerun",
            automatic=True,
            target_run="10",
            target_sha=GOOD_SHA,
            target_url="https://github.com/acme/shop/actions/runs/10",
            current_sha=BAD_SHA,
        )
        assert fetch.requests[0].get_header("Authorization") == "Bearer gh-test-0000"

    def test_execute(self, fake_fetch):
        fetch = fake_fetch(
            {"https://api.github.com/repos/acme/shop/actions/runs/10/rerun": (201, b"")}
        )
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        assert execute_rollback(GITHUB_ENV, RUN, plan, fetch)
        assert fetch.requests[0].get_method() == "POST"
        assert not execute_rollback({}, RUN, plan, fetch)
        assert not execute_rollback(
            GITHUB_ENV,
            RUN,
            RollbackPlan("github", "rerun", automatic=True, target_run="../x"),
            fetch,
        )

    def test_repo_from_settings(self, fake_fetch):
        env = {**GITHUB_ENV, "CICD_GITHUB_REPO": "acme/other"}
        fetch = fake_fetch(
            {"https://api.github.com/repos/acme/other/": (200, {"workflow_runs": []})}
        )
        assert (
            plan_rollback(env, {**RUN, "pr_url": ""}, fetch).reason
            == "no_previous_success"
        )

    @pytest.mark.parametrize(
        "env,run",
        [
            ({}, RUN),
            ({**GITHUB_ENV, "CICD_GITHUB_WORKFLOW": "../x"}, RUN),
            (GITHUB_ENV, {**RUN, "pr_url": "https://evil.example/a/b/pull/1"}),
            ({**GITHUB_ENV, "CICD_GITHUB_REPO": "../.."}, RUN),
        ],
    )
    def test_not_configured(self, fake_fetch, env, run):
        assert plan_rollback(env, run, fake_fetch()).reason == "not_configured"

    def test_unreachable(self, fake_fetch):
        assert (
            plan_rollback(GITHUB_ENV, RUN, fake_fetch({GH_RUNS: (500, b"")})).reason
            == "unreachable"
        )
        assert (
            plan_rollback(GITHUB_ENV, RUN, fake_fetch({GH_RUNS: (200, b"nope")})).reason
            == "unreachable"
        )
        assert plan_rollback(GITHUB_ENV, RUN, fake_fetch()).reason == "unreachable"

    def test_no_run_after_the_trigger(self, fake_fetch):
        runs = _gh_runs()
        runs["workflow_runs"] = runs["workflow_runs"][1:]
        plan = plan_rollback(GITHUB_ENV, RUN, fake_fetch({GH_RUNS: (200, runs)}))
        assert (plan.reason, plan.current_sha) == ("rerun", "")


def _azure_routes(good_version: object = GOOD_SHA) -> dict:
    return {
        f"{AZ}?": (
            200,
            {
                "value": [
                    {
                        "id": 31,
                        "result": None,
                        "createdDate": "2026-11-15T10:00:07.1234567Z",
                    },
                    {
                        "id": 21,
                        "result": "succeeded",
                        "createdDate": "2026-11-15T09:00:00Z",
                        "_links": {
                            "web": {"href": "https://dev.azure.com/acme/run/21"}
                        },
                    },
                    {"id": "no", "createdDate": "2026-11-15T09:00:00Z"},
                    7,
                ]
            },
        ),
        f"{AZ}/21?": (
            200,
            {
                "resources": {
                    "repositories": {
                        "self": {"refName": "refs/heads/main", "version": good_version}
                    }
                }
            },
        ),
        f"{AZ}/31?": (
            200,
            {"resources": {"repositories": {"self": {"version": BAD_SHA}}}},
        ),
    }


class TestAzure:
    def test_plan_redeploys_the_last_good_commit(self, fake_fetch):
        plan = plan_rollback(
            AZURE_ENV, {**RUN, "provider": "azure"}, fake_fetch(_azure_routes())
        )
        assert (plan.reason, plan.automatic, plan.target_run) == (
            "redeploy_commit",
            True,
            "21",
        )
        assert (plan.target_sha, plan.current_sha) == (GOOD_SHA, BAD_SHA)
        assert plan.target_url == "https://dev.azure.com/acme/run/21"

    def test_execute_pins_the_commit(self, fake_fetch):
        routes = _azure_routes()
        routes[f"{AZ}?api-version=7.1"] = lambda request: (
            (201, b"{}") if request.get_method() == "POST" else routes[f"{AZ}?"]
        )
        fetch = fake_fetch(routes)
        plan = RollbackPlan(
            "azure",
            "redeploy_commit",
            automatic=True,
            target_run="21",
            target_sha=GOOD_SHA,
        )
        assert execute_rollback(AZURE_ENV, RUN, plan, fetch)
        post = [r for r in fetch.requests if r.get_method() == "POST"][0]
        body = json.loads(post.data)  # type: ignore[arg-type]
        assert body["resources"]["repositories"]["self"] == {
            "refName": "refs/heads/main",
            "version": GOOD_SHA,
        }
        assert post.get_header("Content-type") == "application/json"

    def test_execute_refuses(self, fake_fetch):
        good = RollbackPlan(
            "azure",
            "redeploy_commit",
            automatic=True,
            target_run="21",
            target_sha=GOOD_SHA,
        )
        assert not execute_rollback({}, RUN, good, fake_fetch())
        bad_sha = RollbackPlan(
            "azure", "redeploy_commit", automatic=True, target_run="21", target_sha="zz"
        )
        assert not execute_rollback(AZURE_ENV, RUN, bad_sha, fake_fetch())
        no_ref = fake_fetch({f"{AZ}/21?": (200, {"resources": {}})})
        assert not execute_rollback(AZURE_ENV, RUN, good, no_ref)
        failing = fake_fetch({f"{AZ}/21?": (404, b"")})
        assert not execute_rollback(AZURE_ENV, RUN, good, failing)

    def test_plan_without_commit(self, fake_fetch):
        plan = plan_rollback(
            AZURE_ENV, {**RUN, "provider": "azure"}, fake_fetch(_azure_routes(None))
        )
        assert (plan.reason, plan.target_run) == ("unreachable", "21")

    def test_plan_failures(self, fake_fetch):
        azure = {**RUN, "provider": "azure"}
        assert plan_rollback({}, azure, fake_fetch()).reason == "not_configured"
        assert (
            plan_rollback(AZURE_ENV, azure, fake_fetch({AZ: (403, b"")})).reason
            == "unreachable"
        )
        empty = fake_fetch({AZ: (200, {"value": []})})
        assert plan_rollback(AZURE_ENV, azure, empty).reason == "no_previous_success"

    def test_no_current_run(self, fake_fetch):
        routes = _azure_routes()
        routes[f"{AZ}?"][1]["value"].pop(0)
        plan = plan_rollback(
            AZURE_ENV, {**RUN, "provider": "azure"}, fake_fetch(routes)
        )
        assert plan.current_sha == ""


GITLAB_ENV = {
    "CICD_GITLAB_TOKEN": "gl-test-0000",
    "CICD_GITLAB_PROJECT_ID": "acme/shop",
}
GL = "https://gitlab.com/api/v4/projects/acme%2Fshop/pipelines"


class TestGitlab:
    def test_manual_plan_names_the_last_good_pipeline(self, fake_fetch):
        pipelines = [
            {
                "id": 9,
                "status": "running",
                "created_at": "2026-11-15T10:01:00Z",
                "sha": BAD_SHA,
            },
            {
                "id": 8,
                "status": "success",
                "created_at": "2026-11-15T09:00:00Z",
                "sha": GOOD_SHA,
                "web_url": "https://gitlab.com/acme/shop/-/pipelines/8",
            },
            "junk",
        ]
        fetch = fake_fetch({GL: (200, pipelines)})
        plan = plan_rollback(GITLAB_ENV, {**RUN, "provider": "gitlab"}, fetch)
        assert (plan.reason, plan.automatic, plan.target_run, plan.current_sha) == (
            "manual",
            False,
            "8",
            BAD_SHA,
        )
        assert fetch.requests[0].get_header("Private-token") == "gl-test-0000"
        assert not execute_rollback(GITLAB_ENV, RUN, plan, fetch)

    def test_failures(self, fake_fetch):
        gitlab = {**RUN, "provider": "gitlab"}
        assert plan_rollback({}, gitlab, fake_fetch()).reason == "not_configured"
        plain = {**GITLAB_ENV, "CICD_GITLAB_HOST": "http://gitlab.internal"}
        assert plan_rollback(plain, gitlab, fake_fetch()).reason == "not_configured"
        assert (
            plan_rollback(GITLAB_ENV, gitlab, fake_fetch({GL: (200, {"x": 1})})).reason
            == "unreachable"
        )
        no_current = [
            {"id": 8, "status": "success", "created_at": "2026-11-15T09:00:00Z"}
        ]
        plan = plan_rollback(GITLAB_ENV, gitlab, fake_fetch({GL: (200, no_current)}))
        assert (plan.reason, plan.current_sha) == ("manual", "")
        assert (
            plan_rollback(GITLAB_ENV, gitlab, fake_fetch({GL: (200, [])})).reason
            == "no_previous_success"
        )


JENKINS_ENV = {"CICD_JENKINS_URL": "https://ci.example", "CICD_JENKINS_JOB": "deploy"}
JK = "https://ci.example/job/deploy/api/json"
BEFORE_MS = 1763193600000  # 2025-11-15T08:00:00Z


class TestJenkins:
    def test_manual_plan(self, fake_fetch):
        builds = {
            "builds": [
                {
                    "number": 41,
                    "result": "SUCCESS",
                    "timestamp": BEFORE_MS,
                    "url": "https://ci.example/job/deploy/41/",
                },
                {
                    "number": 40,
                    "result": "SUCCESS",
                    "timestamp": BEFORE_MS - 1,
                    "url": "javascript:x",
                },
                {"number": 39, "result": "FAILURE", "timestamp": "x"},
            ]
        }
        fetch = fake_fetch({JK: (200, builds)})
        plan = plan_rollback(
            {**JENKINS_ENV, "CICD_JENKINS_TOKEN": "jk-0000", "CICD_JENKINS_USER": "me"},
            {**RUN, "provider": "jenkins"},
            fetch,
        )
        assert (plan.reason, plan.target_run, plan.target_url) == (
            "manual",
            "41",
            "https://ci.example/job/deploy/41/",
        )
        assert fetch.requests[0].get_header("Authorization").startswith("Basic ")

    def test_bearer_and_no_token_over_http(self, fake_fetch):
        fetch = fake_fetch({JK: (200, {"builds": []})})
        plan = plan_rollback(
            {**JENKINS_ENV, "CICD_JENKINS_TOKEN": "jk-0000"},
            {**RUN, "provider": "jenkins"},
            fetch,
        )
        assert plan.reason == "no_previous_success"
        assert fetch.requests[0].get_header("Authorization") == "Bearer jk-0000"
        plain = fake_fetch({"http://ci.example": (200, {"builds": []})})
        plan_rollback(
            {
                "CICD_JENKINS_URL": "http://ci.example",
                "CICD_JENKINS_JOB": "deploy",
                "CICD_JENKINS_TOKEN": "jk-0000",
            },
            {**RUN, "provider": "jenkins"},
            plain,
        )
        assert plain.requests[0].get_header("Authorization") is None

    def test_failures(self, fake_fetch):
        jenkins = {**RUN, "provider": "jenkins"}
        assert plan_rollback({}, jenkins, fake_fetch()).reason == "not_configured"
        assert (
            plan_rollback(JENKINS_ENV, jenkins, fake_fetch({JK: (200, [])})).reason
            == "unreachable"
        )


class TestDispatch:
    def test_unsupported(self, fake_fetch):
        assert (
            plan_rollback({}, {**RUN, "provider": "circleci"}, fake_fetch()).reason
            == "unsupported"
        )
        assert (
            plan_rollback({}, {**RUN, "triggered_at": "soon"}, fake_fetch()).reason
            == "unsupported"
        )
        assert (
            plan_rollback({}, {**RUN, "triggered_at": None}, fake_fetch()).reason
            == "unsupported"
        )

    def test_naive_trigger_time_is_utc(self, fake_fetch):
        fetch = fake_fetch({GH_RUNS: (200, _gh_runs())})
        assert (
            plan_rollback(
                GITHUB_ENV, {**RUN, "triggered_at": "2026-11-15T10:00:00"}, fetch
            ).target_run
            == "10"
        )

    def test_provider_from_settings(self, fake_fetch):
        env = {**GITHUB_ENV, "CICD_PROVIDER": "github"}
        fetch = fake_fetch({GH_RUNS: (200, _gh_runs())})
        assert plan_rollback(env, {**RUN, "provider": ""}, fetch).reason == "rerun"

    def test_network_errors(self):
        def broken(_request):
            raise OSError("down")

        assert plan_rollback(GITHUB_ENV, RUN, broken).reason == "unreachable"
        plan = RollbackPlan("github", "rerun", automatic=True, target_run="10")
        assert not execute_rollback(GITHUB_ENV, RUN, plan, broken)

    def test_execute_needs_an_automatic_plan(self, fake_fetch):
        assert not execute_rollback(
            GITHUB_ENV, RUN, RollbackPlan("github", "manual"), fake_fetch()
        )
        odd = RollbackPlan("circleci", "rerun", automatic=True)
        assert not execute_rollback(GITHUB_ENV, RUN, odd, fake_fetch())
        assert RollbackPlan("x", "y").to_dict()["reason"] == "y"

"""What an Azure DevOps PR review reads from Azure Repos, and the comment it can post.

Azure DevOps has no unified-diff endpoint: `AzDOClient` rebuilds one from the
PR's branches and the files of its latest iteration, and falls back to a
per-file summary (path, change type, line counts) whenever it cannot read both
sides of a file. The Azure Repos API is a scripted stand-in (conftest.py);
the client, the shared connector and its models are the real ones.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from runners.azure_devops.azdo_client import AzDOClient


@pytest.fixture
def client(tmp_path: Path, azure) -> AzDOClient:
    return AzDOClient(
        project_dir=tmp_path,
        pat=azure.pat,
        organization_url=azure.org_url,
        project=azure.project,
        repository_id=azure.repo,
    )


class TestTheDiffIsRebuiltFromBothBranches:
    def test_an_edited_file_shows_its_changed_lines(self, client, azure):
        azure.change("/src/total.py")
        azure.files[("main", "/src/total.py")] = "def total():\n    return 1\n"
        azure.files[("feature/checkout", "/src/total.py")] = (
            "def total():\n    return 2\n"
        )

        diff = client.get_pr_diff(7)

        assert "--- a//src/total.py" in diff
        assert "+++ b//src/total.py" in diff
        assert "-    return 1" in diff
        assert "+    return 2" in diff
        assert azure.connections == [
            {"base_url": azure.org_url, "creds": azure.connections[0]["creds"]}
        ]

    def test_a_relative_path_is_read_from_the_repository_root(self, client, azure):
        azure.change("docs/readme.md")
        azure.files[("main", "/docs/readme.md")] = "old\n"
        azure.files[("feature/checkout", "/docs/readme.md")] = "new\n"

        diff = client.get_pr_diff(7)

        assert "-old" in diff and "+new" in diff
        assert azure.fetched == [
            ("main", "/docs/readme.md"),
            ("feature/checkout", "/docs/readme.md"),
        ]

    def test_an_added_file_is_only_read_on_the_pr_branch(self, client, azure):
        azure.change("/new.py", "add")
        azure.files[("feature/checkout", "/new.py")] = "print('hi')\n"

        diff = client.get_pr_diff(7)

        assert "+print('hi')" in diff
        assert azure.fetched == [("feature/checkout", "/new.py")]

    def test_a_deleted_file_is_only_read_on_the_target_branch(self, client, azure):
        azure.change("/old.py", "Delete")
        azure.files[("main", "/old.py")] = "print('bye')\n"

        diff = client.get_pr_diff(7)

        assert "-print('bye')" in diff
        assert azure.fetched == [("main", "/old.py")]

    def test_tag_refs_and_bare_branch_names_are_both_understood(self, client, azure):
        azure.pr.source_ref_name = "hotfix"
        azure.pr.target_ref_name = "refs/tags/v1.0"
        azure.change("/a.py")
        azure.files[("v1.0", "/a.py")] = "a = 1\n"
        azure.files[("hotfix", "/a.py")] = "a = 2\n"

        diff = client.get_pr_diff(7)

        assert "+a = 2" in diff
        assert azure.fetched == [("v1.0", "/a.py"), ("hotfix", "/a.py")]

    def test_an_unchanged_file_adds_nothing(self, client, azure):
        azure.change("/same.py")
        azure.files[("main", "/same.py")] = "x = 1\n"
        azure.files[("feature/checkout", "/same.py")] = "x = 1\n"

        assert client.get_pr_diff(7) == ""


class TestTheSummaryStandsInForWhatCannotBeRead:
    def test_an_unreadable_pr_gives_a_summary_of_every_file(self, client, azure):
        azure.change("/x.py", additions=3, deletions=1)
        azure.change("/y.py")
        # The changes are read, then the PR itself cannot be.
        azure.failures["get_pull_request"] = RuntimeError("503 Service Unavailable")

        diff = client.get_pr_diff(7)

        assert diff == (
            "--- a//x.py\n+++ b//x.py\n# Change type: edit\n"
            "# +3 additions\n# -1 deletions\n"
            "\n"
            "--- a//y.py\n+++ b//y.py\n# Change type: edit\n"
        )
        assert azure.fetched == []

    def test_a_pr_without_branch_refs_gives_a_summary(self, client, azure):
        azure.pr.source_ref_name = None
        azure.change("/x.py")

        assert (
            client.get_pr_diff(7) == "--- a//x.py\n+++ b//x.py\n# Change type: edit\n"
        )
        assert azure.fetched == []

    def test_a_file_missing_on_a_branch_is_summarised_alone(self, client, azure):
        azure.change("/ok.py")
        azure.change("/gone.py", "rename")
        azure.files[("main", "/ok.py")] = "v = 1\n"
        azure.files[("feature/checkout", "/ok.py")] = "v = 2\n"

        diff = client.get_pr_diff(7)

        assert "+v = 2" in diff
        assert "--- a//gone.py\n+++ b//gone.py\n# Change type: rename\n" in diff

    def test_an_entry_without_path_or_type_is_still_listed(self, client, azure):
        azure.change("", "")

        assert client.get_pr_diff(7) == (
            "--- a/unknown\n+++ b/unknown\n# Change type: edit\n"
        )

    def test_files_past_the_cap_are_only_summarised(self, client, azure):
        for i in range(5):
            azure.change(f"/f{i}.py")
            azure.files[("main", f"/f{i}.py")] = "x = 0\n"
            azure.files[("feature/checkout", f"/f{i}.py")] = f"x = {i + 1}\n"

        diff = client.get_pr_diff(7, max_files=2)

        assert diff.count("@@") == 4  # two real hunks, two @@ markers each
        assert diff.count("# Change type: edit") == 3
        assert {path for _, path in azure.fetched} == {"/f0.py", "/f1.py"}

    @pytest.mark.parametrize("big_side", ["main", "feature/checkout"])
    def test_a_file_too_big_on_either_side_is_summarised(self, client, azure, big_side):
        azure.change("/huge.bin")
        azure.files[("main", "/huge.bin")] = "a\n"
        azure.files[("feature/checkout", "/huge.bin")] = "b\n"
        azure.files[(big_side, "/huge.bin")] = "x" * 20_000

        diff = client.get_pr_diff(7, max_file_bytes=10_000)

        assert diff == "--- a//huge.bin\n+++ b//huge.bin\n# Change type: edit\n"


class TestThePullRequest:
    def test_the_details_are_the_connectors_view_of_the_pr(self, client, azure):
        azure.change("/a.py", additions=2, deletions=1)

        details = client.get_pull_request(7)

        assert details["title"] == "Add checkout page"
        assert details["sourceRefName"] == "refs/heads/feature/checkout"
        assert details["createdBy"] == {"displayName": "Ada Lovelace"}
        assert details["files"][0]["path"] == "/a.py"
        assert (details["additions"], details["deletions"]) == (2, 1)

    def test_one_connection_serves_every_call(self, client, azure):
        client.get_pull_request(7)
        client.get_pr_diff(7)

        assert len(azure.connections) == 1


class TestPostingAComment:
    def test_the_comment_opens_an_active_thread_on_the_pr(self, client, azure):
        assert client.post_pr_comment(7, "Looks good.") is True

        assert azure.threads == [
            {
                "pr": 7,
                "repo": azure.repo,
                "project": azure.project,
                "status": "active",
                "comments": ["Looks good."],
            }
        ]

    def test_a_refused_comment_is_reported_not_raised(self, client, azure, capsys):
        azure.failures["create_thread"] = RuntimeError("403 Forbidden")

        assert client.post_pr_comment(7, "Looks good.") is False
        assert azure.threads == []
        assert "Failed to post comment: 403 Forbidden" in capsys.readouterr().out

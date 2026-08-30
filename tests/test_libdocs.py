"""`libdocs`: what gets downloaded, what deliberately does not, and what must
never be mistaken for documentation.

Three properties carry the feature, and each has a way of failing silently.

**The repository decides, not popularity.** A library used in twenty files is
skipped on purpose: the codebase teaches it better, house conventions included.
A library declared and imported nowhere is the case the download exists for. A
detector that stopped counting imports would still look like it worked — it
would just quietly download the wrong four libraries every build.

**An error body is not a page.** `/v2/context` answers a spent quota with HTTP
200 and a JSON error. Written to the cache, `{"error": "Quota Exceeded"}` is
served to the coder as documentation for a fortnight.

**Nothing here fails a build.** No network, no key, nothing indexed: the result
says so and the pipeline carries on with the MCP tools it always had.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from libdocs import (  # noqa: E402
    Context7Client,
    Context7Error,
    Context7RateLimited,
    DocsCache,
    Library,
    detect_needs,
    format_docs_for_prompt,
    load_result,
    read_manifests,
    run_preflight,
)
from libdocs.context7 import pick_version  # noqa: E402
from libdocs.detect import mentioned_libraries, usage_counts  # noqa: E402

# ---------------------------------------------------------------------------
# doubles
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, text: str, status: int = 200, headers: dict | None = None):
        self.text = text
        self.status_code = status
        self.headers = headers or {}


class FakeSession:
    """A Context7 that answers from a script and records what it was asked."""

    def __init__(self, search: object = None, docs: object = None):
        self.search = search
        self.docs = docs
        self.calls: list[tuple[str, dict]] = []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, dict(params or {})))
        answer = self.search if "/libs/search" in url else self.docs
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, FakeResponse):
            return answer
        return FakeResponse(
            json.dumps(answer) if not isinstance(answer, str) else answer
        )


def a_project(tmp_path: Path, **files: str) -> Path:
    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    for name, body in files.items():
        path = project / name.replace("__", "/")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return project


def a_spec(tmp_path: Path, task: str = "") -> Path:
    spec = tmp_path / "specs" / "001-x"
    spec.mkdir(parents=True, exist_ok=True)
    if task:
        (spec / "spec.md").write_text(task, encoding="utf-8")
    return spec


ONE_RESULT = {
    "results": [
        {
            "id": "/stripe/stripe-node",
            "title": "Stripe Node",
            "state": "finalized",
            "trustScore": 9,
            "totalSnippets": 400,
        }
    ]
}


# ---------------------------------------------------------------------------
# detection
# ---------------------------------------------------------------------------


class TestManifests:
    def test_a_monorepo_is_read_below_its_root(self, tmp_path):
        """The root manifest alone would report zero dependencies here."""
        project = a_project(
            tmp_path,
            **{
                "apps__web__package.json": json.dumps(
                    {"dependencies": {"recharts": "^2.12.0"}}
                ),
                "apps__api__requirements.txt": "fastapi>=0.110\n# a comment\n",
            },
        )
        deps = read_manifests(project)
        assert deps["recharts"].ecosystem == "npm"
        assert deps["recharts"].version == "^2.12.0"
        assert deps["fastapi"].ecosystem == "pypi"

    def test_a_scoped_package_keeps_a_prose_name(self, tmp_path):
        project = a_project(
            tmp_path,
            **{
                "package.json": json.dumps(
                    {"dependencies": {"@tanstack/react-query": "^5.0.0"}}
                )
            },
        )
        deps = read_manifests(project)
        assert deps["@tanstack/react-query"].short_name == "react-query"

    def test_a_broken_manifest_does_not_take_the_others_down(self, tmp_path):
        project = a_project(
            tmp_path,
            **{
                "package.json": "{ this is not json",
                "requirements.txt": "httpx==0.28.1\n",
            },
        )
        assert "httpx" in read_manifests(project)


class TestWhatTheTaskNames:
    def test_declared_names_are_matched_through_prose(self, tmp_path):
        deps = read_manifests(
            a_project(
                tmp_path,
                **{
                    "package.json": json.dumps({"dependencies": {"recharts": "^2.0.0"}})
                },
            )
        )
        named, _ = mentioned_libraries("Add a Recharts bar chart to the board", deps)
        assert named == {"recharts"}

    def test_an_undeclared_backticked_name_is_a_candidate(self, tmp_path):
        deps = read_manifests(a_project(tmp_path))
        _, undeclared = mentioned_libraries("Use `zustand` for the store", deps)
        assert undeclared == {"zustand"}

    def test_prose_that_only_looks_like_a_package_is_dropped(self, tmp_path):
        deps = read_manifests(a_project(tmp_path))
        _, undeclared = mentioned_libraries(
            "Run `pnpm run dev`, then edit `src/App.tsx` and read `README.md`. "
            "Set `true` on the flag.",
            deps,
        )
        assert undeclared == set()

    def test_a_substring_is_not_a_mention(self, tmp_path):
        """ "reactive" is not "react", and one letter decides four thousand
        tokens of the wrong documentation."""
        deps = read_manifests(
            a_project(
                tmp_path,
                **{"package.json": json.dumps({"dependencies": {"react": "^19.0.0"}})},
            )
        )
        named, _ = mentioned_libraries("Make the layout reactive on resize", deps)
        assert named == set()


class TestUsageEvidence:
    def _repo(self, tmp_path: Path) -> Path:
        return a_project(
            tmp_path,
            **{
                "package.json": json.dumps(
                    {"dependencies": {"zustand": "^5.0.0", "recharts": "^2.12.0"}}
                ),
                "src__store.ts": "import { create } from 'zustand';\n",
                "src__other.ts": "import { create } from 'zustand';\n",
                "src__third.ts": "import { create } from 'zustand';\n",
            },
        )

    def test_the_manifest_itself_is_not_usage(self, tmp_path):
        project = self._repo(tmp_path)
        counts = usage_counts(project, {"recharts": "npm", "zustand": "npm"})
        assert counts["recharts"] == 0
        assert counts["zustand"] == 3

    def test_a_widely_used_library_is_not_downloaded(self, tmp_path):
        project = self._repo(tmp_path)
        needs = detect_needs(project, "Rework the zustand store and add recharts")
        names = [need.name for need in needs]
        assert "recharts" in names
        assert "zustand" not in names

    def test_an_undeclared_library_outranks_a_thinly_used_one(self, tmp_path):
        project = a_project(
            tmp_path,
            **{
                "package.json": json.dumps({"dependencies": {"recharts": "^2.12.0"}}),
                "src__chart.ts": "import { Bar } from 'recharts';\n",
            },
        )
        needs = detect_needs(
            project, "Chart with recharts, styled with `vanilla-extract`"
        )
        assert needs[0].name == "vanilla-extract"

    def test_a_task_naming_nothing_falls_back_to_unused_dependencies(self, tmp_path):
        project = a_project(
            tmp_path,
            **{
                "package.json": json.dumps({"dependencies": {"recharts": "^2.12.0"}}),
            },
        )
        needs = detect_needs(project, "Tidy the header spacing")
        assert [need.name for need in needs] == ["recharts"]
        assert "declared" in needs[0].reasons

    def test_a_distribution_whose_module_is_named_differently_counts_as_used(
        self, tmp_path
    ):
        """`PyYAML` is imported as `yaml`, and "unused" is what triggers a
        download — the mismatch spends the budget on a library the repository
        uses on every other file."""
        project = a_project(
            tmp_path,
            **{
                "requirements.txt": "PyYAML>=6.0\n",
                "app__loader.py": "import yaml\n",
            },
        )
        assert usage_counts(project, {"PyYAML": "pypi"})["PyYAML"] == 1

    def test_a_mature_repository_downloads_nothing_for_a_task_naming_nothing(
        self, tmp_path
    ):
        """The fallback is for a project with no examples of its own stack.

        A repository with hundreds of source files has them by definition, so
        guessing there would spend the whole budget on whichever dependency
        happens to sort first.
        """
        files = {f"src__module_{i}.ts": "export const x = 1;\n" for i in range(80)}
        files["package.json"] = json.dumps({"dependencies": {"recharts": "^2.12.0"}})
        project = a_project(tmp_path, **files)
        assert detect_needs(project, "Tidy the header spacing") == []

    def test_the_budget_is_a_hard_cap(self, tmp_path):
        deps = {f"lib-{i}": "^1.0.0" for i in range(12)}
        project = a_project(
            tmp_path, **{"package.json": json.dumps({"dependencies": deps})}
        )
        assert len(detect_needs(project, "", limit=3)) == 3


# ---------------------------------------------------------------------------
# the client
# ---------------------------------------------------------------------------


class TestContext7Client:
    def test_an_error_body_behind_a_200_is_not_documentation(self):
        """The failure this guards: a spent quota answers 200 with JSON."""
        session = FakeSession(
            docs=FakeResponse(
                json.dumps({"error": "Quota Exceeded", "message": "Monthly quota"})
            )
        )
        client = Context7Client("k", session=session)
        with pytest.raises(Context7RateLimited):
            client.docs("/vercel/next.js", "routing")

    def test_a_rate_limit_carries_its_retry_after(self):
        session = FakeSession(
            search=FakeResponse("", status=429, headers={"Retry-After": "30"})
        )
        with pytest.raises(Context7RateLimited) as caught:
            Context7Client("k", session=session).search("next", "routing")
        assert caught.value.retry_after == 30

    def test_a_transport_failure_is_reported_not_raised_raw(self):
        session = FakeSession(search=OSError("no route to host"))
        with pytest.raises(Context7Error):
            Context7Client("k", session=session).search("next", "routing")

    def test_resolve_prefers_the_exact_name_over_the_louder_entry(self):
        session = FakeSession(
            search={
                "results": [
                    {
                        "id": "/some/react-admin-kit",
                        "title": "React Admin Kit",
                        "state": "finalized",
                        "trustScore": 10,
                        "totalSnippets": 9000,
                    },
                    {
                        "id": "/reactjs/react.dev",
                        "title": "React",
                        "state": "finalized",
                        "trustScore": 8,
                        "totalSnippets": 5000,
                    },
                ]
            }
        )
        best = Context7Client("k", session=session).resolve("react", "hooks")
        assert best.id == "/reactjs/react.dev"

    def test_the_api_key_travels_in_a_header(self):
        session = FakeSession(search=ONE_RESULT)

        captured = {}

        def get(url, params=None, headers=None, timeout=None):
            captured.update(headers or {})
            return FakeResponse(json.dumps(ONE_RESULT))

        session.get = get
        Context7Client("ctx7sk-secret", session=session).search("stripe", "checkout")
        assert captured["Authorization"] == "Bearer ctx7sk-secret"

    @pytest.mark.parametrize(
        "declared,expected",
        [
            ("^15.1.0", "v15.2.3"),
            ("15.0.1", "v15.2.3"),
            ("^14.0.0", "v14.0.1"),
            ("^18.0.0", ""),
            ("", ""),
        ],
    )
    def test_the_declared_major_selects_the_indexed_version(self, declared, expected):
        library = Library(
            id="/vercel/next.js", versions=("v14.0.1", "v15.1.8", "v15.2.3")
        )
        assert pick_version(library, declared) == expected


# ---------------------------------------------------------------------------
# the cache
# ---------------------------------------------------------------------------


class TestCache:
    def test_a_page_survives_to_the_next_build(self, tmp_path):
        cache = DocsCache(tmp_path)
        cache.put("/vercel/next.js", "next", "routing", "# routing\n")
        again = DocsCache(tmp_path).get("/vercel/next.js", "routing")
        assert again is not None
        assert again.read().startswith("# routing")

    def test_a_different_question_is_a_different_entry(self, tmp_path):
        cache = DocsCache(tmp_path)
        cache.put("/vercel/next.js", "next", "routing", "routes")
        assert cache.get("/vercel/next.js", "middleware") is None

    def test_a_page_older_than_the_ttl_is_not_served(self, tmp_path):
        DocsCache(tmp_path).put("/vercel/next.js", "next", "routing", "old")
        index = json.loads(
            (tmp_path / ".workpilot" / "docs-cache" / "index.json").read_text()
        )
        for record in index.values():
            record["fetched_at"] = "2020-01-01T00:00:00+00:00"
        (tmp_path / ".workpilot" / "docs-cache" / "index.json").write_text(
            json.dumps(index), encoding="utf-8"
        )
        assert DocsCache(tmp_path).get("/vercel/next.js", "routing") is None

    def test_a_record_whose_file_vanished_is_not_served(self, tmp_path):
        cache = DocsCache(tmp_path)
        doc = cache.put("/vercel/next.js", "next", "routing", "body")
        doc.path.unlink()
        assert cache.get("/vercel/next.js", "routing") is None

    def test_writing_leaves_no_temporary_files_behind(self, tmp_path):
        cache = DocsCache(tmp_path)
        cache.put("/vercel/next.js", "next", "routing", "body")
        leftovers = [p.name for p in cache.root.iterdir() if p.name.endswith(".tmp")]
        assert leftovers == []


# ---------------------------------------------------------------------------
# the preflight
# ---------------------------------------------------------------------------


class TestPreflight:
    def _project(self, tmp_path):
        return a_project(
            tmp_path,
            **{"package.json": json.dumps({"dependencies": {"stripe": "^14.0.0"}})},
        )

    def _client(self, docs="# Stripe\n\ncheckout.sessions.create(...)"):
        return Context7Client(
            "k", session=FakeSession(search=ONE_RESULT, docs=FakeResponse(docs))
        )

    def test_the_page_lands_where_the_agent_can_read_it(self, tmp_path, monkeypatch):
        monkeypatch.delenv("CONTEXT7_ENABLED", raising=False)
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout to the billing page")
        result = run_preflight(project, spec, client=self._client())

        assert [e.library for e in result.entries] == ["stripe"]
        staged = spec / "docs" / "stripe.md"
        assert staged.exists()
        assert "checkout.sessions.create" in staged.read_text(encoding="utf-8")
        # Provenance on top, so a reader can judge the page's age later.
        assert "/stripe/stripe-node" in staged.read_text(encoding="utf-8")

    def test_the_result_is_readable_by_the_next_process(self, tmp_path):
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        run_preflight(project, spec, client=self._client())

        reloaded = load_result(spec)
        assert [e.library_id for e in reloaded.entries] == ["/stripe/stripe-node"]

    def test_the_cache_stays_out_of_the_worktree(self, tmp_path):
        """A worktree is deleted on merge; the download must not go with it."""
        source = self._project(tmp_path)
        (tmp_path / "wt").mkdir()
        worktree = a_project(
            tmp_path / "wt",
            **{"package.json": json.dumps({"dependencies": {"stripe": "^14.0.0"}})},
        )
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        run_preflight(worktree, spec, cache_dir=source, client=self._client())

        assert (source / ".workpilot" / "docs-cache" / "index.json").exists()
        assert not (worktree / ".workpilot" / "docs-cache").exists()

    def test_the_second_build_does_not_pay_again(self, tmp_path):
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        session = FakeSession(search=ONE_RESULT, docs=FakeResponse("# Stripe"))
        client = Context7Client("k", session=session)

        run_preflight(project, spec, client=client)
        fetches = sum(1 for url, _ in session.calls if "/v2/context" in url)
        run_preflight(project, spec, client=client)
        assert sum(1 for url, _ in session.calls if "/v2/context" in url) == fetches
        assert run_preflight(project, spec, client=client).entries[0].from_cache

    def test_a_dead_network_does_not_fail_the_build(self, tmp_path):
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        client = Context7Client("k", session=FakeSession(search=OSError("offline")))

        result = run_preflight(project, spec, client=client)
        assert result.entries == []
        assert result.errors and "stripe" in result.errors[0]

    def test_a_library_the_index_does_not_know_is_reported_as_skipped(self, tmp_path):
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        client = Context7Client("k", session=FakeSession(search={"results": []}))

        result = run_preflight(project, spec, client=client)
        assert result.entries == []
        assert result.skipped[0][0] == "stripe"

    def test_a_previous_task_s_result_does_not_survive_this_one(self, tmp_path):
        """Otherwise the coder reads a list of what the *last* task needed."""
        files = {f"src__module_{i}.ts": "export const x = 1;\n" for i in range(60)}
        files["package.json"] = json.dumps({"dependencies": {"stripe": "^14.0.0"}})
        project = a_project(tmp_path, **files)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        run_preflight(project, spec, client=self._client())
        assert load_result(spec).entries

        (spec / "spec.md").write_text("Tidy the header spacing", encoding="utf-8")
        run_preflight(project, spec, client=self._client())
        assert load_result(spec).entries == []

    def test_a_spent_quota_stops_the_loop_instead_of_burning_it(self, tmp_path):
        """The quota does not come back mid-build; the other candidates would
        each spend a call to be told the same thing."""
        project = a_project(
            tmp_path,
            **{
                "package.json": json.dumps(
                    {"dependencies": {"stripe": "^14.0.0", "recharts": "^2.12.0"}}
                )
            },
        )
        spec = a_spec(tmp_path, "Add `stripe` checkout and a `recharts` graph")
        session = FakeSession(
            search=ONE_RESULT,
            docs=FakeResponse("", status=429, headers={"Retry-After": "60"}),
        )
        result = run_preflight(
            project, spec, client=Context7Client("k", session=session)
        )

        assert len(result.errors) == 1
        assert sum(1 for url, _ in session.calls if "/v2/context" in url) == 1

    def test_turning_context7_off_turns_this_off_too(self, tmp_path, monkeypatch):
        monkeypatch.setenv("CONTEXT7_ENABLED", "false")
        project = self._project(tmp_path)
        spec = a_spec(tmp_path, "Add `stripe` checkout")
        result = run_preflight(project, spec, client=self._client())
        assert result.enabled is False
        assert not (spec / "docs").exists()

    def test_the_project_env_file_is_honoured(self, tmp_path, monkeypatch):
        monkeypatch.delenv("CONTEXT7_ENABLED", raising=False)
        monkeypatch.delenv("LIBDOCS_ENABLED", raising=False)
        project = self._project(tmp_path)
        env = project / ".workpilot" / ".env"
        env.parent.mkdir(parents=True, exist_ok=True)
        env.write_text("CONTEXT7_ENABLED=false\n", encoding="utf-8")

        spec = a_spec(tmp_path, "Add `stripe` checkout")
        assert run_preflight(project, spec, client=self._client()).enabled is False


class TestThePromptSection:
    def _result(self, tmp_path):
        project = a_project(
            tmp_path,
            **{
                "package.json": json.dumps(
                    {"dependencies": {"stripe": "^14.0.0", "recharts": "^2.12.0"}}
                )
            },
        )
        spec = a_spec(tmp_path, "Add `stripe` checkout and a `recharts` graph")
        client = Context7Client(
            "k",
            session=FakeSession(search=ONE_RESULT, docs=FakeResponse("# docs")),
        )
        return run_preflight(project, spec, client=client)

    def test_it_points_at_the_file_rather_than_inlining_it(self, tmp_path):
        section = format_docs_for_prompt(self._result(tmp_path))
        assert "specs/001-x/docs/stripe.md" in section.replace("\\", "/")
        assert "# docs" not in section

    def test_nothing_downloaded_means_no_section_at_all(self):
        assert format_docs_for_prompt(None) == ""

    def test_a_disabled_run_injects_nothing(self, tmp_path):
        """Off means off, including for pages an earlier build left staged."""
        result = self._result(tmp_path)
        result.enabled = False
        assert format_docs_for_prompt(result) == ""

    def test_the_subtask_s_own_library_is_listed_first(self, tmp_path):
        result = self._result(tmp_path)
        assert len(result.entries) == 2
        section = format_docs_for_prompt(
            result, subtask={"description": "Draw the recharts bar chart"}
        )
        first = next(line for line in section.splitlines() if line.startswith("- "))
        assert "recharts" in first


class TestTheBuildIsWired:
    """The two joins that make the download reach a prompt.

    Detection and fetching are useless if the build never calls them, and the
    call is useless if the coder never sees the result — both ends have been
    written and left unconnected in this pipeline before.
    """

    def test_the_build_calls_the_preflight_before_planning(self):
        import inspect

        from cli import build_commands

        source = inspect.getsource(build_commands.handle_build_command)
        assert "_run_docs_preflight" in source
        assert source.index("_run_docs_preflight") < source.index('before="planning"')

    def test_the_preflight_helper_survives_a_disabled_context7(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("CONTEXT7_ENABLED", "false")
        from cli.build_commands import _run_docs_preflight

        project = a_project(tmp_path)
        spec = a_spec(tmp_path, "anything")
        _run_docs_preflight(project, spec, project)  # must not raise, must not call out

    def test_the_coder_reads_the_staged_result(self, tmp_path):
        """The section is read from disk, not re-detected every subtask."""
        from agents.coder import _docs_section

        spec = a_spec(tmp_path)
        (spec / "docs_context.json").write_text(
            json.dumps(
                {
                    "enabled": True,
                    "entries": [
                        {
                            "library": "stripe",
                            "library_id": "/stripe/stripe-node",
                            "query": "checkout",
                            "path": ".workpilot/specs/001-x/docs/stripe.md",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        section = _docs_section(spec, {"description": "Wire up billing"})
        assert ".workpilot/specs/001-x/docs/stripe.md" in section

    def test_a_spec_with_no_preflight_adds_nothing_to_the_prompt(self, tmp_path):
        from agents.coder import _docs_section

        assert _docs_section(a_spec(tmp_path), {"description": "x"}) == ""

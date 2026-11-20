"""What the archify layer does with input it did not expect.

The model is written by a session and the status record is a file anyone can
edit, so both reach this code before anything has validated their shape. These
tests hand it the shapes a careless writer produces and check that each one is
read as absent — never as a crash in the code that reads it before archify
does.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from architecture_visualizer.archify import (
    authoring,
    cli,
    delta,
    ir,
    prompts,
    runtime,
    significance,
    task_delta,
)


def model(**extra) -> dict:
    data = {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {"title": "T"},
        "components": [{"id": "a", "type": "backend", "label": "A"}],
    }
    data.update(extra)
    return data


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / ".github" / "workflows").mkdir(parents=True)
    (root / ".github" / "workflows" / "ci.yml").write_text("on: push\n", "utf-8")
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
    git(root, "init", "-q")
    git(root, "config", "user.email", "t@example.invalid")
    git(root, "config", "user.name", "t")
    git(root, "config", "commit.gpgsign", "false")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "init")
    git(root, "remote", "add", "origin", "https://user:pw@github.com/o/r.git")
    return root


# --------------------------------------------------------------------------- #
# ir
# --------------------------------------------------------------------------- #


class TestLoad:
    def test_a_non_object_is_refused(self, tmp_path: Path):
        path = tmp_path / "m.json"
        path.write_text("[1]", encoding="utf-8")
        with pytest.raises(ir.IRError, match="does not hold a JSON object"):
            ir.load(path)

    def test_bytes_that_are_not_utf8_are_an_ir_error(self, tmp_path: Path):
        path = tmp_path / "m.json"
        path.write_bytes(b'{"a": "\xff"}')
        with pytest.raises(ir.IRError, match="not UTF-8"):
            ir.load(path)

    def test_a_directory_is_an_ir_error(self, tmp_path: Path):
        (tmp_path / "m.json").mkdir()
        with pytest.raises(ir.IRError, match="cannot be read"):
            ir.load(tmp_path / "m.json")


class TestShapes:
    def test_components_that_are_not_a_list_are_none(self):
        assert ir.components({"components": {"a": {"id": "a"}}}) == []
        assert ir.component_ids({"components": 3}) == set()
        assert ir.source_paths({"components": "a"}) == set()

    def test_entries_that_are_not_objects_are_skipped(self):
        data = {
            "components": [
                "a",
                {"id": "b", "sources": [{"path": "./src/b.py"}, "x", {"path": ""}]},
                {"id": "c", "sources": {"path": "src/c.py"}},
            ]
        }
        assert ir.component_ids(data) == {"b", "c"}
        assert ir.source_paths(data) == {"src/b.py"}

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            (".github/workflows/ci.yml", ".github/workflows/ci.yml"),
            ("./.env.example", ".env.example"),
            ("././src\\app.py", "src/app.py"),
            ("/src/app.py", "src/app.py"),
            ("../outside.py", "../outside.py"),
        ],
    )
    def test_only_the_leading_dot_slash_is_removed(self, raw: str, expected: str):
        assert ir.normalise_path(raw) == expected


class TestPinRepository:
    def test_a_hidden_folder_source_is_kept_when_tracked(self, repo: Path):
        data = model(
            components=[
                {
                    "id": "ci",
                    "sources": [
                        {"path": ".github/workflows/ci.yml"},
                        {"path": "gone.py"},
                    ],
                },
                {"id": "app", "sources": [{"path": "./src/app.py"}]},
                {"id": "none", "sources": [{"path": "missing.py"}]},
            ]
        )

        pinned, sha = ir.pin_repository(data, repo)

        assert sha == git(repo, "rev-parse", "HEAD")
        by_id = {c["id"]: c for c in pinned["components"]}
        assert by_id["ci"]["sources"] == [{"path": ".github/workflows/ci.yml"}]
        assert by_id["app"]["sources"] == [{"path": "./src/app.py"}]
        assert "sources" not in by_id["none"]
        # The credentials of the clone URL never reach the file.
        assert pinned["meta"]["repository"] == {
            "url": "https://github.com/o/r.git",
            "revision": sha,
        }

    def test_a_meta_that_is_not_an_object_is_replaced(self, repo: Path):
        data = model(
            meta="T", components=[{"id": "a", "sources": [{"path": "src/app.py"}]}]
        )

        pinned, sha = ir.pin_repository(data, repo)

        assert pinned["meta"] == {
            "repository": {"url": "https://github.com/o/r.git", "revision": sha}
        }

    def test_nothing_cited_at_the_commit_strips_all_evidence(self, repo: Path):
        data = model(
            meta={"repository": {"url": "x"}},
            components=[{"id": "a", "sources": [{"path": "new.py"}]}, "junk"],
        )

        pinned, sha = ir.pin_repository(data, repo)

        assert sha is None
        assert pinned["meta"] == {}
        assert pinned["components"][0] == {"id": "a"}

    def test_no_citation_at_all_strips_evidence(self, repo: Path):
        pinned, sha = ir.pin_repository(model(meta="T"), repo)

        assert sha is None and pinned["meta"] == "T"

    def test_without_git_nothing_is_pinned(self, tmp_path: Path, monkeypatch):
        def no_git(*_a, **_k):
            raise FileNotFoundError("git")

        monkeypatch.setattr(ir.subprocess, "run", no_git)
        data = model(components=[{"id": "a", "sources": [{"path": "a.py"}]}])

        pinned, sha = ir.pin_repository(data, tmp_path)

        assert sha is None and pinned["components"] == [{"id": "a"}]

    def test_a_failed_listing_tracks_nothing(self, repo: Path, monkeypatch):
        real = ir._git

        def no_listing(args, cwd):
            return None if args[0] == "ls-tree" else real(args, cwd)

        monkeypatch.setattr(ir, "_git", no_listing)

        assert ir._tracked_at(repo, "HEAD", {"src/app.py"}) == set()

    @pytest.mark.parametrize(
        ("url", "mode"),
        [
            ("git@github.com:org/repo.git", None),
            ("git@gitlab.example.com:org/repo.git", "local-only"),
            ("https://enterprise.github.com/o/r", None),
            ("/srv/git/repo.git", "local-only"),
        ],
    )
    def test_link_mode(self, url: str, mode: str | None):
        assert ir._link_mode(url) == mode


# --------------------------------------------------------------------------- #
# significance
# --------------------------------------------------------------------------- #


class TestSignificance:
    def test_the_dot_of_an_ignored_folder_is_kept(self):
        assert significance.is_structural("./src/app.py")
        assert not significance.is_structural(".workpilot/specs/x.py")
        assert not significance.is_structural(".venv/lib/x.py")

    def test_a_hidden_folder_source_owns_its_changes(self, tmp_path: Path):
        baseline = tmp_path / "baseline.arch.json"
        baseline.write_text(
            json.dumps(
                model(
                    components=[
                        "junk",
                        {"sources": [{"path": "src"}]},
                        {"id": "x", "sources": ["junk", {"path": ""}]},
                        {"id": "tool", "sources": [{"path": ".tools/gen"}]},
                    ]
                )
            ),
            encoding="utf-8",
        )

        found = significance.assess([".tools/gen/run.py"], baseline)

        assert found.significant
        assert found.matched_components == ["tool"]
        assert found.to_dict() == {
            "significant": True,
            "reason": "1 modelled component(s) own a changed file",
            "matchedComponents": ["tool"],
            "structuralFiles": [".tools/gen/run.py"],
        }


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #


class TestReceiptSummary:
    @pytest.mark.parametrize(
        ("receipt", "line"),
        [
            (cli.Receipt(ok=True, command="validate"), "validate: ok"),
            (
                cli.Receipt(
                    ok=False,
                    command="validate",
                    payload={"diagnostics": [{"code": "c"}]},
                ),
                "validate: c",
            ),
            (
                cli.Receipt(ok=False, command="deliver", payload={"error": "boom"}),
                "deliver: boom",
            ),
            (
                cli.Receipt(ok=False, command="compare", exit_code=3),
                "compare: failed with exit code 3",
            ),
        ],
    )
    def test_one_line_per_case(self, receipt: cli.Receipt, line: str):
        assert receipt.summary() == line


@pytest.fixture
def ready(monkeypatch, tmp_path: Path):
    """A runtime that says yes, and a recorder in place of the subprocess."""
    root = tmp_path / "archify"
    monkeypatch.setattr(
        cli,
        "check",
        lambda: SimpleNamespace(ok=True, node="node", archify_root=root, blockers=[]),
    )
    calls: list[list[str]] = []
    answer = {"stdout": "", "returncode": 0}

    def run(command, **_kwargs):
        calls.append(command)
        if isinstance(answer.get("raise"), BaseException):
            raise answer["raise"]
        return SimpleNamespace(
            stdout=answer["stdout"], stderr="", returncode=answer["returncode"]
        )

    monkeypatch.setattr(cli.subprocess, "run", run)
    return SimpleNamespace(calls=calls, answer=answer, root=root)


class TestInvoke:
    def test_an_unready_runtime_raises_with_the_doctor(self, monkeypatch):
        blocker = SimpleNamespace(name="node", detail="missing", remedy="install")
        monkeypatch.setattr(
            cli,
            "check",
            lambda: SimpleNamespace(ok=False, blockers=[blocker]),
        )

        with pytest.raises(cli.ArchifyUnavailable, match="node: missing"):
            cli.doctor()

    def test_a_timeout_is_a_failed_receipt(self, ready):
        ready.answer["raise"] = subprocess.TimeoutExpired("node", 60)

        receipt = cli.doctor()

        assert not receipt.ok and receipt.exit_code == -1
        assert receipt.summary() == "doctor: archify timed out after 60s"

    def test_stdout_that_is_not_a_json_object_leaves_the_payload_empty(self, ready):
        ready.answer["stdout"] = "{not json"
        assert cli.doctor().payload == {}

        ready.answer["stdout"] = "[1, 2]"
        assert cli.doctor().payload == {}

    def test_a_payload_saying_not_ok_wins_over_exit_zero(self, ready):
        ready.answer["stdout"] = json.dumps({"ok": False, "command": "validate"})

        receipt = cli.validate(Path("m.json"), diagram_type="workflow")

        assert not receipt.ok
        # No `--repo-root` for a diagram type that has no repository evidence.
        assert "--repo-root" not in ready.calls[-1]

    def test_compare_writes_its_receipt_beside_the_artifact(self, ready, tmp_path):
        out = tmp_path / "out"

        receipt = cli.compare(
            tmp_path / "a.json",
            tmp_path / "b.json",
            out / "delta.html",
            receipt=out / "r" / "delta.receipt.json",
        )

        assert receipt.ok
        command = ready.calls[-1]
        assert command[:3] == [
            "node",
            str(ready.root / "bin" / "archify.mjs"),
            "compare",
        ]
        assert command[command.index("--receipt") + 1] == str(
            (out / "r" / "delta.receipt.json").resolve()
        )
        assert "--repo-root" not in command
        assert (out / "r").is_dir()

    def test_compare_without_a_receipt_names_the_repository(self, ready, tmp_path):
        cli.compare(
            tmp_path / "a.json",
            tmp_path / "b.json",
            tmp_path / "delta.html",
            repo_root=tmp_path,
        )

        command = ready.calls[-1]
        assert "--receipt" not in command
        assert command[-2:] == ["--repo-root", str(tmp_path.resolve())]


# --------------------------------------------------------------------------- #
# runtime
# --------------------------------------------------------------------------- #


class TestNodeVersion:
    def test_a_node_that_cannot_run(self, monkeypatch):
        def broken(*_a, **_k):
            raise PermissionError("denied")

        monkeypatch.setattr(runtime.subprocess, "run", broken)

        ok, detail = runtime._node_version("node")

        assert not ok and detail == "could not be run: denied"

    @pytest.mark.parametrize(("out", "detail"), [("weird", "weird"), ("", "unknown")])
    def test_an_unparseable_version_is_not_a_refusal(self, monkeypatch, out, detail):
        monkeypatch.setattr(
            runtime.subprocess,
            "run",
            lambda *_a, **_k: SimpleNamespace(stdout=out, stderr=""),
        )

        assert runtime._node_version("node") == (True, detail)


# --------------------------------------------------------------------------- #
# delta
# --------------------------------------------------------------------------- #


class TestStatusRecord:
    def write(self, spec_dir: Path, raw: object) -> None:
        path = delta.status_path(spec_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(raw), encoding="utf-8")

    def test_no_record(self, tmp_path: Path):
        assert delta.read_status(tmp_path) is None

    def test_a_record_that_is_not_an_object(self, tmp_path: Path):
        self.write(tmp_path, ["mapped"])
        assert delta.read_status(tmp_path) is None

    def test_a_record_that_is_not_utf8(self, tmp_path: Path):
        path = delta.status_path(tmp_path)
        path.parent.mkdir(parents=True)
        path.write_bytes(b'{"status": "\xff"}')

        assert delta.read_status(tmp_path) is None

    def test_fields_of_the_wrong_shape_are_read_as_absent(self, tmp_path: Path):
        self.write(
            tmp_path,
            {
                "status": "mapped",
                "summary": [{"added": 3}],
                "continuity": "high",
                "artifact": ["x"],
                "receipt": 4,
                "baselineRevision": {"sha": "x"},
                "headRevision": "abc",
            },
        )

        status = delta.read_status(tmp_path)

        assert status is not None
        assert status.summary == {} and status.continuity == {}
        assert status.has_changes is False
        assert (status.artifact, status.receipt) == (None, None)
        assert (status.baseline_revision, status.head_revision) == (None, "abc")

    def test_a_given_timestamp_is_kept(self, tmp_path: Path):
        status = delta.write_status(
            tmp_path, delta.DeltaStatus(status="failed", generated_at="then")
        )

        assert status.generated_at == "then"
        assert delta.read_status(tmp_path).generated_at == "then"

    @pytest.mark.parametrize(
        "meta",
        ["T", {"repository": "x"}, {"repository": {"revision": ""}}, None],
    )
    def test_a_revision_of_any_other_shape_is_none(self, meta):
        assert delta._revision({"meta": meta}) is None


class TestCompareModels:
    @pytest.fixture
    def models_on_disk(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr(delta, "check", lambda: SimpleNamespace(ok=True))
        base, head = tmp_path / "base.json", tmp_path / "head.json"
        ir.save(base, model(meta={"repository": {"revision": "b" * 40}}))
        ir.save(head, model(meta="untitled"))
        return SimpleNamespace(spec=tmp_path / "spec", base=base, head=head)

    def test_a_missing_runtime_is_recorded(self, tmp_path: Path, monkeypatch):
        blockers = [
            SimpleNamespace(remedy="install node", detail="x"),
            SimpleNamespace(remedy="", detail="no archify"),
        ]
        monkeypatch.setattr(
            delta, "check", lambda: SimpleNamespace(ok=False, blockers=blockers)
        )

        status = delta.compare_models(
            tmp_path, tmp_path / "a", tmp_path / "b", tmp_path
        )

        assert status.status == delta.STATUS_RUNTIME_MISSING
        assert status.reason == "install node; no archify"

    def test_an_unreadable_head_is_a_failure(self, models_on_disk, tmp_path):
        status = delta.compare_models(
            models_on_disk.spec, models_on_disk.base, tmp_path / "nope.json", tmp_path
        )

        assert status.status == delta.STATUS_FAILED
        assert "no architecture model" in status.reason

    def test_a_refused_comparison_is_a_failure(
        self, models_on_disk, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(
            delta.cli,
            "compare",
            lambda **_k: cli.Receipt(
                ok=False, command="compare", payload={"error": "no"}
            ),
        )

        status = delta.compare_models(
            models_on_disk.spec, models_on_disk.base, models_on_disk.head, tmp_path
        )

        assert status.status == delta.STATUS_FAILED
        assert status.reason == "compare: no"
        assert status.continuity["reliable"] is True

    def test_a_mapped_delta_with_a_summary_of_another_shape(
        self, models_on_disk, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(
            delta.cli,
            "compare",
            lambda **_k: cli.Receipt(
                ok=True, command="compare", payload={"summary": 1}
            ),
        )

        status = delta.compare_models(
            models_on_disk.spec, models_on_disk.base, models_on_disk.head, tmp_path
        )

        assert status.status == delta.STATUS_MAPPED
        assert status.summary == {} and not status.has_changes
        assert (status.baseline_revision, status.head_revision) == ("b" * 40, None)


# --------------------------------------------------------------------------- #
# authoring, prompts, task delta
# --------------------------------------------------------------------------- #


class TestBuildPrompt:
    def test_without_the_renderer_it_raises_the_doctor(self, monkeypatch, tmp_path):
        monkeypatch.setattr(authoring, "archify_root", lambda: None)
        monkeypatch.setattr(
            authoring, "check", lambda: SimpleNamespace(blockers=[], ok=False)
        )

        with pytest.raises(cli.ArchifyUnavailable):
            authoring.build_prompt(tmp_path, tmp_path / "m.json")

    def test_a_large_baseline_is_compacted_never_cut(self, monkeypatch, tmp_path):
        monkeypatch.setattr(authoring, "archify_root", lambda: tmp_path)
        monkeypatch.setattr(authoring, "MAX_BASELINE_CHARS", 10)
        baseline = model(components=[{"id": f"c{i}"} for i in range(5)])

        text = authoring.build_prompt(
            tmp_path,
            tmp_path / "m.json",
            baseline=baseline,
            task_summary="  Split the API  ",
            changed_files=["src/api.py"],
        )

        assert json.dumps(baseline, separators=(",", ":")) in text
        assert "Split the API" in text
        assert "- `src/api.py`" in text

    def test_a_baseline_within_the_budget_keeps_its_indentation(
        self, monkeypatch, tmp_path
    ):
        monkeypatch.setattr(authoring, "archify_root", lambda: tmp_path)

        text = authoring.build_prompt(tmp_path, tmp_path / "m.json", baseline=model())

        assert json.dumps(model(), indent="\t") in text

    def test_the_delta_section_says_when_nothing_is_known(self):
        section = prompts.architecture_delta_section("{}", "  ", [])

        assert "_No summary available._" in section
        assert "_The set of changed files could not be determined._" in section


class TestAuthorReadsAnyShape:
    @pytest.mark.asyncio
    async def test_a_model_of_the_wrong_shape_reaches_validation(
        self, monkeypatch, tmp_path
    ):
        """Pinning used to raise on a `meta` string; now archify gets to say why."""
        spec = tmp_path / "head.arch.json"
        monkeypatch.setattr(authoring, "build_prompt", lambda **_k: "author")
        monkeypatch.setattr(ir, "_git", lambda *_a: None)
        seen: list[dict] = []

        def refuse(path, **_k):
            seen.append(json.loads(path.read_text(encoding="utf-8")))
            return cli.Receipt(
                ok=False, command="validate", payload={"diagnostics": [{"code": "c"}]}
            )

        monkeypatch.setattr(authoring.cli, "validate", refuse)

        async def session(_prompt: str) -> str:
            spec.write_text(
                json.dumps(model(meta="T", components={"a": 1})), encoding="utf-8"
            )
            return "written"

        result = await authoring.author(
            session=session,
            project_dir=tmp_path,
            spec_path=spec,
            artifact_path=tmp_path / "head.html",
        )

        assert not result.ok and result.error == "validate: c"
        assert seen[0]["meta"] == "T"


class TestTaskDelta:
    @pytest.mark.asyncio
    async def test_an_unusable_baseline_is_recorded(self, tmp_path: Path):
        project = tmp_path / "project"
        baseline = task_delta.baseline_dir(project) / task_delta.BASELINE_SPEC
        baseline.parent.mkdir(parents=True)
        baseline.write_text(json.dumps({"diagram_type": "flow"}), encoding="utf-8")

        async def never(_prompt: str) -> str:
            raise AssertionError("no session for an unusable baseline")

        status = await task_delta.run_task_delta(
            project, tmp_path / "spec", session=never, force=True
        )

        assert status.status == delta.STATUS_FAILED
        assert status.reason.startswith("the baseline model is unusable:")
        assert delta.read_status(tmp_path / "spec").status == delta.STATUS_FAILED

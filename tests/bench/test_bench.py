"""Repo bench: real git repositories, real pytest runs, no LLM.

A toy project lands two cards: ``001-mul`` (adds ``mul`` and its test, merged
with a merge commit) and ``002-docs`` (no test). The builds are played by
hand: a copy gets a right or a wrong ``mul`` the way an agent would write it,
then the judge decides.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from bench import (
    BenchError,
    discard,
    discover,
    history_samples,
    judge_build,
    parse_commits,
    parse_engines,
    parse_specs,
    prepare,
    repo,
    router_verdict,
    scores,
    table,
)
from bench import judge as judging
from bench.layout import main_project, manifest_path, results_path, work_dir
from bench.reports import parse_go_json, parse_jest_json, parse_junit, parse_trx

ENGINE_A = {"provider": "anthropic", "model": "claude-sonnet-4-6", "effort": "high"}
ENGINE_B = {"provider": "openai", "model": "gpt-4.1", "effort": "medium"}

CALC_BASE = "def add(a, b):\n    return a + b\n"
CALC_TARGET = CALC_BASE + "\n\ndef mul(a, b):\n    return a * b\n"
TEST_BASE = "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"
# ``mul`` is imported in its test, so that ``test_add`` still runs at the base.
TEST_TARGET = (
    TEST_BASE
    + "\n\ndef test_mul():\n    from calc import mul\n\n    assert mul(2, 3) == 6\n"
)


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        [
            "git",
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t.invalid",
            "-c",
            "commit.gpgsign=false",
            *args,
        ],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return result.stdout.strip()


def _write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _spec(project: Path, spec_id: str, metadata: dict | None = None) -> None:
    folder = project / ".workpilot" / "specs" / spec_id
    _write(folder, "spec.md", f"# {spec_id}\n\nAdd mul(a, b).\n")
    _write(folder, "requirements.json", json.dumps({"task_description": "mul"}))
    _write(folder, "implementation_plan.json", json.dumps({"status": "done"}))
    _write(folder, "qa_report.md", "the answer is a * b")
    _write(
        folder,
        "task_metadata.json",
        json.dumps(metadata or {"kind": "feature", "prUrl": "https://x/y/z/pull/1"}),
    )


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("WORKPILOT_BENCH_JUDGE_TIMEOUT", "120")
    root = tmp_path / "proj"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _write(root, ".gitignore", ".workpilot/\n")
    _write(root, "calc.py", CALC_BASE)
    _write(root, "tests/test_calc.py", TEST_BASE)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    # Card 001-mul, on its task branch, merged with a merge commit.
    _git(root, "checkout", "-q", "-b", "workpilot/001-mul")
    _write(root, "calc.py", CALC_TARGET)
    _write(root, "tests/test_calc.py", TEST_TARGET)
    _git(root, "commit", "-q", "-am", "auto-claude: mul")
    _git(root, "checkout", "-q", "main")
    _git(
        root,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'workpilot/001-mul'",
        "workpilot/001-mul",
    )
    # Card 002-docs, squashed in by hand: no test, no merge commit.
    _write(root, "README.md", "docs\n")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "docs (#2)")
    _spec(root, "001-mul")
    _spec(root, "002-docs")
    # Every judge in these tests runs the interpreter running them.
    monkeypatch.setattr(judging, "_python", lambda _project: sys.executable)
    return root


def _prepare(project: Path, engines=(ENGINE_A, ENGINE_B)) -> dict:
    return prepare(project, ["001-mul"], parse_engines(list(engines)), {})


def _agent_writes(
    manifest: dict, build_id: str, calc: str, extra: dict | None = None
) -> Path:
    build = next(b for b in manifest["builds"] if b["id"] == build_id)
    copy = Path(build["copy"])
    _write(copy, "calc.py", calc)
    for rel, text in (extra or {}).items():
        _write(copy, rel, text)
    return copy


# --------------------------------------------------------------------------
# discovery


def test_discovery_finds_the_merge_and_the_hidden_tests(project):
    merge = _git(project, "rev-parse", "HEAD~1")
    cases = {c["caseId"]: c for c in discover(project, ["001-mul", "002-docs"], {})}
    mul = cases["001-mul"]
    assert mul["status"] == "candidate"
    assert mul["target"] == merge
    assert mul["base"] == _git(project, "rev-parse", f"{merge}^1")
    assert mul["source"] == "merge"
    assert mul["tests"] == ["tests/test_calc.py"]
    assert mul["runnable"] == ["tests/test_calc.py"]
    docs = cases["002-docs"]
    assert docs["status"] == "refused"
    assert docs["reasonCode"] == "no-target"
    assert "give the commit" in docs["reason"]


def test_a_given_commit_without_test_change_has_no_judge(project):
    docs = _git(project, "rev-parse", "HEAD")
    (case,) = discover(project, ["002-docs"], {"002-docs": docs})
    assert case["status"] == "refused"
    assert case["source"] == "given"
    assert "no judge" in case["reason"]


def test_an_unknown_commit_or_card_is_refused(project):
    (case,) = discover(project, ["001-mul"], {"001-mul": "abcdef1"})
    assert case["status"] == "refused" and "not in the repository" in case["reason"]
    (case,) = discover(project, ["404-none"], {})
    assert case["status"] == "refused" and "no such card" in case["reason"]


def test_a_later_merge_of_the_same_branch_is_not_the_card(project):
    first = _git(project, "rev-parse", "HEAD~1")
    _git(project, "checkout", "-q", "workpilot/001-mul")
    _write(project, "calc.py", CALC_TARGET + "\n# fix\n")
    _git(project, "commit", "-q", "-am", "fix")
    _git(project, "checkout", "-q", "main")
    _git(
        project,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'workpilot/001-mul' again",
        "workpilot/001-mul",
    )
    (case,) = discover(project, ["001-mul"], {})
    assert case["target"] == first
    assert "first one" in case["note"]


def test_a_branch_whose_name_extends_the_card_is_not_the_card(project):
    _git(project, "checkout", "-q", "-b", "workpilot/001-mul-2", "HEAD~2")
    _write(project, "other.py", "x = 1\n")
    _git(project, "add", "-A")
    _git(project, "commit", "-q", "-m", "other")
    _git(project, "checkout", "-q", "main")
    _git(
        project,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'workpilot/001-mul-2'",
        "workpilot/001-mul-2",
    )
    (case,) = discover(project, ["001-mul"], {})
    assert case["target"] == _git(project, "rev-parse", "HEAD~2")


# --------------------------------------------------------------------------
# isolation


def test_a_copy_at_the_base_does_not_hold_the_target(project, tmp_path):
    (case,) = discover(project, ["001-mul"], {})
    copy = tmp_path / "copy"
    repo.isolated_copy(project, case["base"], copy, depth=50)
    assert _git(copy, "rev-parse", "HEAD") == case["base"]
    assert not repo.contains(copy, case["target"])
    assert _git(copy, "remote") == ""
    assert "def mul" not in (copy / "calc.py").read_text(encoding="utf-8")
    assert not (project / ".git" / "refs" / "workpilot-bench").exists() or not any(
        (project / ".git" / "refs" / "workpilot-bench").iterdir()
    )


def test_the_spec_is_copied_without_what_describes_the_answer(project):
    manifest = _prepare(project, [ENGINE_A])
    (build,) = manifest["builds"]
    spec = Path(build["copy"]) / ".workpilot" / "specs" / "001-mul"
    assert sorted(p.name for p in spec.iterdir()) == [
        "requirements.json",
        "spec.md",
        "task_metadata.json",
    ]
    metadata = json.loads((spec / "task_metadata.json").read_text(encoding="utf-8"))
    assert metadata["engineLocked"] is True
    assert metadata["phaseModels"]["coding"] == "claude-sonnet-4-6"
    assert metadata["phaseProviders"]["qa"] == "anthropic"
    assert metadata["thinkingLevel"] == "high"
    assert metadata["requireReviewBeforeCoding"] is False
    assert metadata["kind"] == "feature"
    assert "prUrl" not in metadata
    assert metadata["bench"]["buildId"] == "b1"


def test_copies_live_outside_the_project(project):
    manifest = _prepare(project, [ENGINE_A])
    copy = Path(manifest["builds"][0]["copy"]).resolve()
    assert not copy.is_relative_to(project.resolve())
    assert copy.is_relative_to(work_dir(project, manifest["runId"]).resolve())


# --------------------------------------------------------------------------
# calibration and judging


def test_calibration_splits_fail_to_pass_from_pass_to_pass(project):
    manifest = _prepare(project)
    (case,) = manifest["cases"]
    assert case["status"] == "ready", case.get("reason")
    assert case["f2p"] == ["tests.test_calc::test_mul"]
    assert case["p2p"] == ["tests.test_calc::test_add"]
    assert [(s["kind"], s["files"]) for s in case["suites"]] == [
        ("pytest", ["tests/test_calc.py"])
    ]
    assert [b["engineId"] for b in manifest["builds"]] == ["v1", "v2"]
    assert manifest["phase"] == "running"
    assert not (work_dir(project, manifest["runId"]) / "cases").exists() or not any(
        (work_dir(project, manifest["runId"]) / "cases").iterdir()
    )


def test_a_right_build_resolves_and_a_wrong_one_does_not(project):
    manifest = _prepare(project)
    _agent_writes(manifest, "b1", CALC_TARGET)
    _agent_writes(manifest, "b2", CALC_BASE + "\n\ndef mul(a, b):\n    return a + b\n")
    run = manifest["runId"]
    after_first = judge_build(
        project,
        run,
        "b1",
        "ended",
        0,
        "2026-10-26T10:00:00+00:00",
        "2026-10-26T10:05:00+00:00",
    )
    assert after_first["phase"] == "running"
    done = judge_build(project, run, "b2", "ended", 0)
    builds = {b["id"]: b for b in done["builds"]}
    assert builds["b1"]["state"] == "judged" and builds["b1"]["resolved"] is True
    assert builds["b1"]["durationS"] == 300
    assert builds["b2"]["resolved"] is False
    assert builds["b2"]["f2pPassed"] == 0 and builds["b2"]["p2pPassed"] == 1
    assert done["phase"] == "done"
    assert not Path(builds["b1"]["copy"]).exists()
    root = work_dir(project, run)
    assert sorted(p.name for p in root.iterdir()) == ["logs"]
    assert "test_mul" in (root / "logs" / "b2.log").read_text(encoding="utf-8")
    rows = {(r["provider"], r["model"]): r for r in table(project)}
    stored = json.loads(results_path(project).read_text(encoding="utf-8"))
    assert stored["table"] == table(project)
    assert rows[("anthropic", "claude-sonnet-4-6")]["rate"] == 1.0
    assert rows[("openai", "gpt-4.1")]["rate"] == 0.0
    assert rows[("openai", "gpt-4.1")]["f2pRate"] == 0.0


def test_a_build_that_wrote_no_mul_fails_its_hidden_test(project):
    manifest = _prepare(project, [ENGINE_A])
    done = judge_build(project, manifest["runId"], "b1", "ended", 1)
    (build,) = done["builds"]
    assert build["state"] == "judged" and build["resolved"] is False


def test_the_agents_own_tests_and_conftest_do_not_judge(project):
    manifest = _prepare(project, [ENGINE_A])
    cheat = (
        "import pytest\n\n\n@pytest.hookimpl(hookwrapper=True)\n"
        "def pytest_runtest_makereport(item, call):\n"
        "    outcome = yield\n    report = outcome.get_result()\n"
        "    report.outcome = 'passed'\n"
    )
    _agent_writes(
        manifest,
        "b1",
        CALC_BASE + "\n\ndef mul(a, b):\n    return 0\n",
        {
            "conftest.py": cheat,
            "tests/conftest.py": cheat,
            "tests/test_calc.py": "def test_mul():\n    assert True\n",
        },
    )
    done = judge_build(project, manifest["runId"], "b1", "ended", 0)
    (build,) = done["builds"]
    assert build["resolved"] is False
    assert sorted(build["resetTests"]) == ["conftest.py", "tests/conftest.py"]


def test_a_link_planted_where_the_tests_go_is_refused(project, tmp_path):
    manifest = _prepare(project, [ENGINE_A])
    copy = Path(manifest["builds"][0]["copy"])
    outside = tmp_path / "outside"
    outside.mkdir()
    shutil.rmtree(copy / "tests")
    try:
        (copy / "tests").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symbolic links need a privilege here")
    done = judge_build(project, manifest["runId"], "b1", "ended", 0)
    (build,) = done["builds"]
    assert build["state"] == "skipped"
    assert "link" in build["reason"]
    assert list(outside.iterdir()) == []


def test_a_build_holding_the_target_is_not_counted(project):
    manifest = _prepare(project, [ENGINE_A])
    copy = Path(manifest["builds"][0]["copy"])
    target = manifest["cases"][0]["target"]
    subprocess.run(
        ["git", "fetch", "-q", project.resolve().as_uri(), target],
        cwd=copy,
        check=True,
        capture_output=True,
    )
    done = judge_build(project, manifest["runId"], "b1", "ended", 0)
    (build,) = done["builds"]
    assert build["state"] == "skipped"
    assert build["reasonCode"] == "saw-answer"
    assert "saw the answer" in build["reason"]
    assert table(project) == []


def test_unstarted_and_interrupted_builds_are_not_counted(project):
    manifest = _prepare(project)
    judge_build(project, manifest["runId"], "b1", "not-started", -1)
    done = judge_build(project, manifest["runId"], "b2", "interrupted", None)
    assert {b["state"] for b in done["builds"]} == {"skipped"}
    assert table(project) == []
    with pytest.raises(BenchError):
        judge_build(project, manifest["runId"], "b1", "ended", 0)


def test_a_card_whose_tests_already_pass_is_excluded(project):
    # A card that only touched a test which passed before it.
    _git(project, "checkout", "-q", "-b", "workpilot/003-tidy")
    _write(project, "tests/test_calc.py", TEST_TARGET + "\n# tidy\n")
    _git(project, "commit", "-q", "-am", "tidy")
    _git(project, "checkout", "-q", "main")
    _git(
        project,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge branch 'workpilot/003-tidy'",
        "workpilot/003-tidy",
    )
    _spec(project, "003-tidy")
    manifest = prepare(project, ["003-tidy"], parse_engines([ENGINE_A]), {})
    (case,) = manifest["cases"]
    assert case["status"] == "excluded"
    assert case["reasonCode"] == "already-passes"
    assert "already passes" in case["reason"]
    assert manifest["builds"] == [] and manifest["phase"] == "done"


def test_a_card_whose_tests_never_pass_is_excluded(project, monkeypatch):
    monkeypatch.setattr(judging, "_python", lambda _project: str(project / "no-python"))
    manifest = _prepare(project, [ENGINE_A])
    (case,) = manifest["cases"]
    assert case["status"] == "excluded"
    assert case["reasonCode"] == "never-passes"
    assert "passes at its target" in case["reason"]


def test_discard_removes_the_copies_and_keeps_the_table(project):
    manifest = _prepare(project)
    _agent_writes(manifest, "b1", CALC_TARGET)
    judge_build(project, manifest["runId"], "b1", "ended", 0)
    discarded = discard(project, manifest["runId"])
    assert discarded["phase"] == "discarded"
    assert not work_dir(project, manifest["runId"]).exists()
    assert len(table(project)) == 1
    stored = json.loads(
        manifest_path(project, manifest["runId"]).read_text(encoding="utf-8")
    )
    assert stored["builds"][1]["reason"] == "the run was discarded"


# --------------------------------------------------------------------------
# what reads the table


def test_formula_lab_and_router_read_the_table(project):
    for _ in range(3):
        manifest = _prepare(project, [ENGINE_B])
        _agent_writes(manifest, "b1", CALC_BASE + "\n\ndef mul(a, b):\n    return 1\n")
        judge_build(project, manifest["runId"], "b1", "ended", 0)
    samples = history_samples(project)
    assert (
        samples
        == [
            {
                "provider": "openai",
                "model": "gpt-4.1",
                "success": False,
                "source": "bench",
            }
        ]
        * 3
    )
    score = scores(project)[("openai", "gpt-4.1")]
    assert score == {"resolved": 0, "judged": 3, "cases": 1}
    # One card three times is not three cards.
    assert router_verdict(score) is False
    assert router_verdict({"resolved": 1, "judged": 3, "cases": 3}) is True
    assert router_verdict({"resolved": 2, "judged": 4, "cases": 4}) is False
    # A build in a task worktree reads the project's table.
    worktree = project / ".workpilot" / "worktrees" / "tasks" / "004-x"
    assert main_project(worktree) == project
    assert scores(worktree) == scores(project)


# --------------------------------------------------------------------------
# requests


def test_requests_are_validated():
    with pytest.raises(BenchError):
        parse_engines([])
    with pytest.raises(BenchError):
        parse_engines([ENGINE_A, ENGINE_A])
    with pytest.raises(BenchError):
        parse_engines([{**ENGINE_A, "provider": "Bad Provider"}])
    with pytest.raises(BenchError):
        parse_specs(["../x"])
    with pytest.raises(BenchError):
        parse_specs([f"{i:03d}-x" for i in range(21)])
    with pytest.raises(BenchError):
        parse_commits({"001-x": "not-a-sha"})
    assert parse_commits({"001-x": " ABCDEF1 "}) == {"001-x": "abcdef1"}


@pytest.mark.parametrize(
    "path,test,runnable",
    [
        ("tests/test_calc.py", True, True),
        ("tests/helpers.py", True, False),
        ("pkg/calc_test.py", True, True),
        ("conftest.py", True, False),
        ("src/a.test.ts", True, True),
        ("src/__tests__/a.ts", True, True),
        ("web/vitest.config.ts", True, False),
        ("pkg/x_test.go", True, True),
        ("App.Tests/CalcTests.cs", True, True),
        ("App/Calc.cs", False, False),
        ("App/CalcTests.cs", True, True),
        ("src/calc.py", False, False),
        ("docs/spec/api.yaml", False, False),
        (".workpilot/specs/001/tests/test_x.py", False, False),
    ],
)
def test_test_paths(path, test, runnable):
    assert repo.is_test_path(path) is test
    assert repo.is_runnable_test(path) is runnable


def test_safe_destination_refuses_escapes(tmp_path):
    with pytest.raises(BenchError):
        repo.safe_destination(tmp_path, "../x.py")
    with pytest.raises(BenchError):
        repo.safe_destination(tmp_path, "/etc/x")
    assert repo.safe_destination(tmp_path, "a/b.py") == tmp_path / "a" / "b.py"


# --------------------------------------------------------------------------
# detection and the judge override


def test_detection_groups_files_by_runner(tmp_path):
    _write(
        tmp_path, "web/package.json", json.dumps({"devDependencies": {"vitest": "1"}})
    )
    _write(
        tmp_path, "api/package.json", json.dumps({"devDependencies": {"jest": "29"}})
    )
    _write(tmp_path, "svc/go.mod", "module x\n")
    _write(tmp_path, "App.Tests/App.Tests.csproj", "<Project/>")
    suites = judging.detect_suites(
        tmp_path,
        tmp_path,
        [
            "tests/test_a.py",
            "web/src/a.test.ts",
            "web/src/b.test.ts",
            "api/x.spec.js",
            "svc/pkg/a_test.go",
            "svc/b_test.go",
            "App.Tests/CalcTests.cs",
        ],
    )
    by_kind = {s.kind: s for s in suites}
    assert by_kind["pytest"].files == ["tests/test_a.py"]
    assert by_kind["vitest"].cwd == "web"
    assert by_kind["vitest"].files == ["src/a.test.ts", "src/b.test.ts"]
    assert by_kind["jest"].cwd == "api"
    assert by_kind["go"].cwd == "svc" and by_kind["go"].files == ["./pkg", "."]
    assert by_kind["dotnet"].files == ["App.Tests.csproj"]


def test_a_js_test_without_a_runner_has_no_judge(tmp_path):
    _write(tmp_path, "package.json", json.dumps({"devDependencies": {"mocha": "1"}}))
    with pytest.raises(BenchError, match="vitest or jest"):
        judging.detect_suites(tmp_path, tmp_path, ["a.test.js"])


def test_the_override_comes_from_the_project(tmp_path):
    _write(
        tmp_path,
        ".workpilot/bench.json",
        json.dumps(
            {"judge": {"argv": ["make", "{report}", "{files}"], "report": "junit"}}
        ),
    )
    (suite,) = judging.detect_suites(tmp_path, tmp_path / "copy", ["tests/test_a.py"])
    assert suite.kind == "custom" and suite.files == ["tests/test_a.py"]
    argv = judging.command_for(suite, tmp_path, tmp_path / "copy", Path("r.xml"))
    assert argv == ["make", "r.xml", "tests/test_a.py"]


@pytest.mark.parametrize(
    "judge",
    [
        {"argv": "make test", "report": "junit", "output": "r.xml"},
        {"argv": ["make"], "report": "tap", "output": "r.xml"},
        {"argv": ["make"], "report": "junit"},
        {"argv": ["make"], "report": "junit", "output": "../r.xml"},
    ],
)
def test_a_bad_override_is_refused(tmp_path, judge):
    _write(tmp_path, ".workpilot/bench.json", json.dumps({"judge": judge}))
    with pytest.raises(BenchError):
        judging.custom_suite(tmp_path)


def test_the_judge_environment_carries_no_credential(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_test0000")
    monkeypatch.setenv("NODE_OPTIONS", "--require /tmp/x.js")
    env = judging.judge_env(tmp_path)
    assert "ANTHROPIC_API_KEY" not in env
    assert "GITHUB_TOKEN" not in env
    assert "NODE_OPTIONS" not in env
    assert env["CI"] == "1"
    assert env["PYTHONPATH"].split(judging.os.pathsep)[0] == str(tmp_path)


def test_dependencies_are_the_projects_and_unlinked_before_removal(tmp_path):
    project, copy = tmp_path / "p", tmp_path / "c"
    _write(project, "node_modules/x/index.js", "1")
    _write(copy, "node_modules/evil/index.js", "agent")
    judging.link_dependencies(project, copy, ".")
    assert (copy / "node_modules" / "x" / "index.js").read_text(encoding="utf-8") == "1"
    assert (copy / "node_modules.agent" / "evil").is_dir()
    judging.unlink_dependencies(copy, [])
    assert not (copy / "node_modules").exists()
    assert (project / "node_modules" / "x" / "index.js").is_file()


# --------------------------------------------------------------------------
# reports


def test_junit_report():
    xml = b"""<testsuites><testsuite>
      <testcase classname="t.a" name="ok"/>
      <testcase classname="t.a" name="bad"><failure/></testcase>
      <testcase classname="t.a" name="err"><error/></testcase>
      <testcase classname="t.a" name="skip"><skipped/></testcase>
    </testsuite></testsuites>"""
    assert parse_junit(xml) == {
        "t.a::ok": "pass",
        "t.a::bad": "fail",
        "t.a::err": "fail",
        "t.a::skip": "skip",
    }
    assert parse_junit(b"<not xml") == {}
    bomb = b'<!DOCTYPE x [<!ENTITY a "aaaa">]><testsuite><testcase name="&a;"/></testsuite>'
    assert parse_junit(bomb) == {}


def test_a_test_seen_twice_passes_only_if_both_passed():
    xml = b"""<testsuite><testcase classname="c" name="t"/>
      <testcase classname="c" name="t"><failure/></testcase></testsuite>"""
    assert parse_junit(xml) == {"c::t": "fail"}


def test_jest_and_vitest_json_report(tmp_path):
    report = {
        "testResults": [
            {
                "name": str(tmp_path / "src" / "a.test.ts"),
                "assertionResults": [
                    {"fullName": "a works", "status": "passed"},
                    {"fullName": "a breaks", "status": "failed"},
                    {"fullName": "a later", "status": "todo"},
                ],
            }
        ]
    }
    assert parse_jest_json(json.dumps(report).encode(), tmp_path) == {
        "src/a.test.ts > a works": "pass",
        "src/a.test.ts > a breaks": "fail",
        "src/a.test.ts > a later": "skip",
    }


def test_trx_report():
    trx = b"""<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
      <Results>
        <UnitTestResult testName="App.Tests.CalcTests.Mul" outcome="Passed"/>
        <UnitTestResult testName="App.Tests.CalcTests.Div" outcome="Failed"/>
        <UnitTestResult testName="App.Tests.CalcTests.Skip" outcome="NotExecuted"/>
      </Results></TestRun>"""
    assert parse_trx(trx) == {
        "App.Tests.CalcTests.Mul": "pass",
        "App.Tests.CalcTests.Div": "fail",
        "App.Tests.CalcTests.Skip": "skip",
    }


def test_go_json_report():
    lines = [
        {"Action": "run", "Package": "x/pkg", "Test": "TestA"},
        {"Action": "pass", "Package": "x/pkg", "Test": "TestA"},
        {"Action": "fail", "Package": "x/pkg", "Test": "TestB"},
        {"Action": "pass", "Package": "x/pkg"},
    ]
    data = "\n".join(json.dumps(line) for line in lines).encode() + b"\nnoise\n"
    assert parse_go_json(data) == {"x/pkg/TestA": "pass", "x/pkg/TestB": "fail"}


# --------------------------------------------------------------------------
# the runner


def test_runner_prints_one_json_line(project):
    runner = (
        Path(__file__).resolve().parents[2]
        / "apps"
        / "backend"
        / "runners"
        / "bench_runner.py"
    )
    result = subprocess.run(
        [
            sys.executable,
            str(runner),
            "discover",
            "--project-dir",
            str(project),
            "--specs",
            '["001-mul"]',
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["data"]["cases"][0]["status"] == "candidate"
    result = subprocess.run(
        [
            sys.executable,
            str(runner),
            "discover",
            "--project-dir",
            str(project),
            "--specs",
            '["../x"]',
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 2
    assert json.loads(result.stdout.strip())["error"] == "invalid card id"

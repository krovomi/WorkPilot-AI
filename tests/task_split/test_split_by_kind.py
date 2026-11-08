"""Ceilings by kind of task, and lines weighed by the files a person reviews."""

from __future__ import annotations

import json

import pytest
from task_split import SplitPolicy, plan_slices, resolve_policy, split_spec
from task_split.policy import DEFAULT_MAX_LINES_BY_KIND, NEVER_SPLIT_KINDS
from task_split.review_load import (
    CODE,
    DOCS,
    GENERATED,
    TEST,
    changed_lines_load,
    file_kind,
)
from task_split.slices import subtask_lines
from tasks.classify import TaskKind, classify
from workflows.registry import DEFAULT_WORKFLOW, workflow_name_for

# --- what a file costs to review, on every stack ------------------------------


@pytest.mark.parametrize(
    ("path", "kind"),
    [
        ("src/Api/OrdersController.cs", CODE),
        ("apps/web/src/app/cart.component.ts", CODE),
        ("internal/billing/invoice.go", CODE),
        ("lib/src/screens/home.dart", CODE),
        ("src/main/java/com/acme/Order.java", CODE),
        ("tests/Api.Tests/OrdersControllerTests.cs", TEST),
        ("src/app/cart.component.spec.ts", TEST),
        ("internal/billing/invoice_test.go", TEST),
        ("tests/test_orders.py", TEST),
        ("src/test/java/com/acme/OrderTest.java", TEST),
        ("README.md", DOCS),
        ("docs/architecture/orders.md", DOCS),
        ("CHANGELOG", DOCS),
        ("package-lock.json", GENERATED),
        ("pnpm-lock.yaml", GENERATED),
        ("poetry.lock", GENERATED),
        ("Cargo.lock", GENERATED),
        ("go.sum", GENERATED),
        ("composer.lock", GENERATED),
        ("src/Api/packages.lock.json", GENERATED),
        ("ios/Podfile.lock", GENERATED),
        ("pubspec.lock", GENERATED),
        ("src/__snapshots__/cart.test.ts.snap", GENERATED),
        ("tests/OrdersTests.Create.verified.json", GENERATED),
        ("src/Migrations/20260101_Init.Designer.cs", GENERATED),
        ("dist/bundle.min.js", GENERATED),
        ("lib/models/user.g.dart", GENERATED),
    ],
)
def test_every_stack_s_files_get_their_kind(path, kind):
    assert file_kind(path) == kind


def test_windows_paths_are_read_like_posix_ones():
    assert file_kind("tests\\Api.Tests\\OrdersTests.cs") == TEST


def test_a_diff_counts_deleted_lines_for_a_quarter_and_a_deleted_file_once():
    assert changed_lines_load("src/a.py", added=100, deleted=40) == 110
    assert changed_lines_load("tests/test_a.py", added=100, deleted=0) == 50
    assert changed_lines_load("package-lock.json", added=5000, deleted=4000) == 0
    assert changed_lines_load("src/old.py", 0, 900, file_deleted=True) == 1


def test_a_subtask_weighs_what_a_person_reads():
    code = {"files_to_modify": ["src/a.py"], "estimated_lines": 200}
    tests = {"files_to_create": ["tests/test_a.py"], "estimated_lines": 200}
    mixed = {
        "files_to_modify": ["src/a.py", "tests/test_a.py"],
        "estimated_lines": 200,
    }
    lock = {"files_to_modify": ["package.json", "package-lock.json"]}
    assert subtask_lines(code) == 200
    assert subtask_lines(tests) == 100
    assert subtask_lines(mixed) == 150
    # A manifest bump with its lockfile: the manifest only, by the file count.
    assert subtask_lines(lock) == 30


def test_lockfiles_do_not_count_against_the_file_ceiling():
    many_locks = [f"pkg{i}/package-lock.json" for i in range(30)]
    plan = {
        "phases": [
            {
                "id": "deps",
                "name": "Deps",
                "depends_on": [],
                "subtasks": [
                    {
                        "id": "1",
                        "status": "pending",
                        "files_to_modify": ["package.json", *many_locks],
                        "estimated_lines": 60,
                    }
                ],
            },
            {
                "id": "code",
                "name": "Code",
                "depends_on": ["deps"],
                "subtasks": [
                    {
                        "id": "2",
                        "status": "pending",
                        "files_to_modify": ["src/a.ts"],
                        "estimated_lines": 50,
                    }
                ],
            },
        ]
    }
    assert plan_slices(plan, SplitPolicy(True, 200, 25)) is None


# --- the ceiling follows the kind ---------------------------------------------


def test_each_kind_has_the_ceiling_leub_approved():
    assert DEFAULT_MAX_LINES_BY_KIND == {
        "hotfix": 100,
        "bug_fix": 200,
        "feature": 400,
        "refactoring": 300,
        "upgrade": 200,
        "test": 400,
        "docs": 400,
    }
    assert NEVER_SPLIT_KINDS == {"investigation", "spike", "run"}
    every_kind = {k.value for k in TaskKind}
    assert set(DEFAULT_MAX_LINES_BY_KIND) | NEVER_SPLIT_KINDS == every_kind


@pytest.mark.parametrize(("kind", "lines"), DEFAULT_MAX_LINES_BY_KIND.items())
def test_the_card_s_kind_picks_the_default(kind, lines):
    policy = resolve_policy({"kind": kind}, {})
    assert (policy.enabled, policy.max_lines, policy.kind) == (True, lines, kind)


@pytest.mark.parametrize("kind", sorted(NEVER_SPLIT_KINDS))
def test_work_without_code_to_review_is_never_split(kind):
    assert resolve_policy({"kind": kind}, {}).enabled is False
    # ...unless the card asks for a ceiling itself.
    assert resolve_policy({"kind": kind, "splitMaxLines": 300}, {}).enabled is True


def test_project_table_beats_the_all_kinds_value_and_the_card_beats_both():
    env = {
        "WORKPILOT_SPLIT_MAX_LINES_BY_KIND": json.dumps({"bug_fix": 150}),
        "WORKPILOT_SPLIT_MAX_LINES": "600",
    }
    assert resolve_policy({"kind": "bug_fix"}, env).max_lines == 150
    assert resolve_policy({"kind": "feature"}, env).max_lines == 600
    card = {"kind": "bug_fix", "splitMaxLines": 250}
    assert resolve_policy(card, env).max_lines == 250
    assert resolve_policy(card, env).source == "card"


@pytest.mark.parametrize(
    "raw",
    ["not json", "[1, 2]", json.dumps({"bug_fix": 3}), json.dumps({"bug_fix": True})],
)
def test_a_bad_project_table_falls_back_to_the_default(raw):
    env = {"WORKPILOT_SPLIT_MAX_LINES_BY_KIND": raw}
    assert resolve_policy({"kind": "bug_fix"}, env).max_lines == 200


def test_an_unknown_kind_gets_the_feature_ceiling():
    assert resolve_policy({"kind": "something-new"}, {}).max_lines == 400


def test_a_split_records_the_kind_its_ceiling_was_chosen_for(tmp_path):
    spec = tmp_path / "specs" / "007-fix-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Fix login\n", encoding="utf-8")
    (spec / "task_metadata.json").write_text(
        json.dumps({"category": "bug_fix"}), encoding="utf-8"
    )
    phases = [
        {
            "id": f"p{i}",
            "name": f"P{i}",
            "depends_on": [],
            "subtasks": [
                {
                    "id": str(i),
                    "status": "pending",
                    "files_to_modify": [f"src/m{i}.py"],
                    "estimated_lines": 150,
                }
            ],
        }
        for i in range(2)
    ]
    (spec / "implementation_plan.json").write_text(
        json.dumps({"feature": "Fix login", "phases": phases}), encoding="utf-8"
    )
    # 300 lines: one feature, but two bug fixes (ceiling 200).
    result = split_spec(spec, env={})
    assert result is not None and result.max_lines == 200
    group = json.loads((spec / "task_metadata.json").read_text(encoding="utf-8"))
    assert group["splitGroup"]["kind"] == "bug_fix"


# --- the upgrade kind ---------------------------------------------------------


@pytest.mark.parametrize(
    "title",
    [
        "Mettre à jour les dépendances npm",
        "Montée de version Angular 19",
        "Migrer vers .NET 11",
        "Upgrade Spring Boot to 4.0",
        "Bump axios to 1.8",
        "Update dependencies of the mobile app",
        "Migrate to Flutter 4",
    ],
)
def test_a_version_upgrade_is_its_own_kind(title):
    assert classify(title).kind is TaskKind.UPGRADE


def test_a_dependabot_label_is_an_upgrade():
    found = classify("Some title", metadata={"labels": ["dependencies"]})
    assert (found.kind, found.source) == (TaskKind.UPGRADE, "import")


@pytest.mark.parametrize(
    ("title", "kind"),
    [
        ("Mettre à jour la documentation", TaskKind.DOCS),
        ("Migrer les données clients", TaskKind.RUN),
        ("Corriger le crash au login", TaskKind.BUG_FIX),
    ],
)
def test_other_updates_keep_their_kind(title, kind):
    assert classify(title).kind is kind


def test_an_upgrade_is_built_by_the_feature_workflow():
    assert workflow_name_for(TaskKind.UPGRADE) == DEFAULT_WORKFLOW

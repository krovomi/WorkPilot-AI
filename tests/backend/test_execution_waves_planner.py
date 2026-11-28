"""The execution-wave planner of server mode (``shared_features.waves``),
table-tested like the desktop's (``main/conflict-waves/__tests__``): pure,
deterministic, the same rules in every language.
"""

from __future__ import annotations

import itertools

import pytest
from shared_features.waves.code_links import (
    MAX_CODE_WEIGHT,
    MAX_REMOVED_SYMBOLS,
    build_spec_code,
    code_links,
    distinctive_identifiers,
    import_keys,
    is_distinctive,
    module_key,
    removed_symbols,
)
from shared_features.waves.merge_check import MAX_MERGE_CHECKS, plan_with_merge_checks
from shared_features.waves.planner import (
    MergeOutcome,
    PlannerOptions,
    PlannerTask,
    pair_key,
    plan_execution_waves,
)
from shared_features.waves.scorer import (
    build_footprint,
    file_weight,
    fragile_links,
    normalize_path,
    risk_level,
)

_clock = itertools.count(1)


def task(card: str, files: list[str], **extra) -> PlannerTask:
    values = {
        "id": card,
        "title": card.upper(),
        "status": "backlog",
        "created_at_ms": next(_clock),
        "planned_files": files,
    }
    values.update(extra)
    return PlannerTask(**values)


def options(**extra) -> PlannerOptions:
    values = {
        "max_parallel": 3,
        "tolerance": 0,
        "unplanned_policy": "isolate",
        "drift_threshold": 3,
    }
    values.update(extra)
    return PlannerOptions(**values)


def waves(result) -> list[list[str]]:
    return [sorted(w["taskIds"]) for w in result["waves"]]


# -- scorer ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("file", "weight"),
    [
        ("src/app/main.ts", 1),
        ("services/Billing/Invoice.cs", 1),
        ("package.json", 3),
        ("apps/web/pnpm-lock.yaml", 3),
        ("go.mod", 3),
        ("src/shop.api/shop.api.csproj", 3),
        ("requirements-dev.txt", 3),
        ("gemfile.lock", 3),
        ("vite.config.ts", 2),
        (".github/workflows/ci.yml", 2),
        ("config/app.yaml", 2),
        (".env.local", 2),
        ("appsettings.development.json", 2),
    ],
)
def test_a_file_weighs_by_its_role_in_the_build(file, weight):
    assert file_weight(file) == weight


@pytest.mark.parametrize(
    ("score", "level"),
    [(0, "none"), (1, "low"), (3, "medium"), (5, "high"), (9, "critical")],
)
def test_risk_levels(score, level):
    assert risk_level(score) == level


def test_a_footprint_skips_blanks_and_keeps_the_first_spelling():
    footprint = build_footprint(["", "  ", "Src\\A.cs", 3], ["src/a.cs", "./src/b.cs"])
    assert footprint == {"src/a.cs": "Src/A.cs", "src/b.cs": "./src/b.cs"}
    assert normalize_path("  ././x/Y") == "x/y"
    assert normalize_path("//x") == "x"
    assert build_footprint(["/"]) == {}


def test_fragile_links_are_one_file_each_side_neither_shared():
    a = build_footprint(["api/user.ts", "shared.ts"])
    b = build_footprint(["impl/user_impl.ts", "shared.ts"])
    index = {
        "api/user.ts": frozenset({"impl/user_impl.ts", "shared.ts", "other.ts"}),
        "shared.ts": frozenset({"impl/user_impl.ts"}),
    }
    assert fragile_links(a, b, index) == ["api/user.ts ↔ impl/user_impl.ts"]


# -- code links --------------------------------------------------------------


@pytest.mark.parametrize(
    ("file", "key"),
    [
        ("src/services/user_service.py", "user_service"),
        ("web/components/user-card.tsx", "user-card"),
        ("pkg/billing/index.ts", "billing"),
        ("app/orders/__init__.py", "orders"),
        ("src/core/utils.ts", "core/utils"),
        ("lib/db.rb", "lib/db"),
        ("include/foo.test.h", "foo"),
        ("utils.go", None),
        (".env", None),
        ("index.ts", None),
        ("x.c", None),
        ("-", None),
        ("", None),
    ],
)
def test_module_keys(file, key):
    assert module_key(file) == key


@pytest.mark.parametrize(
    ("line", "key"),
    [
        ("from app.services.user_service import load_user", "user_service"),
        ("import { x } from '../services/userService';", "userservice"),
        ("const db = require('./lib/db');", "lib/db"),
        ('#include "billing/invoice.h"', "invoice"),
        ("use crate::orders::checkout;", "checkout"),
        ("using Acme.Payments;", "payments"),
        ('@import "styles/user-card.css";', "user-card"),
        ("source ./scripts/deploy_env.sh", "deploy_env"),
        ("import x from '--weird--'", "weird"),
    ],
)
def test_import_lines_in_many_languages(line, key):
    assert key in import_keys(f"// header\n{line}\nconst other = 1;\n")


def test_go_import_block_and_lines_that_import_nothing():
    keys = import_keys(
        'package main\n\nimport (\n\t"fmt"\n\t"acme/billing"\n)\n\nvar x = 1\n'
    )
    assert {"fmt", "billing"} <= keys and "x" not in keys
    assert "userservice" not in import_keys("const userService = make();\n")


@pytest.mark.parametrize(
    "identifier",
    ["loadUser", "UserService", "load_user", "MAX_RETRIES", "parse2", "chargéÉtat"],
)
def test_distinctive(identifier):
    assert is_distinctive(identifier)


@pytest.mark.parametrize(
    "identifier", ["user", "Account", "render", "a_b", "_private", "x1", "ab_"]
)
def test_not_distinctive(identifier):
    assert not is_distinctive(identifier)


def test_removed_symbols():
    diff = "\n".join(
        [
            "diff --git a/src/users.py b/src/users.py",
            "--- a/src/users.py",
            "@@ -1,2 +1,2 @@",
            "-def load_user(user_id):",
            "+def fetch_user(user_id):",
            "-KEPT_NAME = keepAround",
            "+KEPT_NAME = 1",
            "diff --git a/b.py b/b.py",
            "-header_only_name",
        ]
    )
    assert removed_symbols(diff, [{"fetch_user", "KEPT_NAME"}]) == [
        "keepAround",
        "load_user",
    ]
    assert removed_symbols(diff, [{"keepAround"}]) == ["load_user"]
    many = "\n".join(
        ["@@ -1 +1 @@", *(f"-name_{i}" for i in range(MAX_REMOVED_SYMBOLS + 5))]
    )
    assert len(removed_symbols(many, [])) == MAX_REMOVED_SYMBOLS
    assert sorted(distinctive_identifiers("def load_user(i): UserCache.get(i)")) == [
        "UserCache",
        "load_user",
    ]


def test_code_links_both_ways_and_never_on_a_shared_file():
    auth = build_footprint(["src/auth/session_store.py", "src/shared.py"])
    billing = build_footprint(["src/billing/invoice.py", "src/shared.py"])
    auth_code = build_spec_code(
        [
            ("src/auth/session_store.py", "def open_session():\n    pass\n"),
            ("src/shared.py", "from billing import invoice\n"),
        ],
        "@@ -1 +1 @@\n-def make_invoice_token():\n+def open_session():\n",
    )
    billing_code = build_spec_code(
        [
            (
                "src/billing/invoice.py",
                "from auth.session_store import open_session\ntoken = make_invoice_token()\n",
            ),
            ("src/shared.py", "make_invoice_token()\n"),
        ],
        None,
    )
    links = code_links(auth, auth_code, billing, billing_code)
    assert links == (
        ["src/billing/invoice.py → src/auth/session_store.py"],
        ["src/billing/invoice.py → make_invoice_token"],
    )
    assert code_links(billing, billing_code, auth, auth_code) == links
    assert code_links(auth, None, billing, billing_code) == ([], [])


# -- planner -----------------------------------------------------------------

CASES = [
    ("independent", [task("a", ["src/a.py"]), task("b", ["web/b.tsx"]), task("c", ["C.cs"])], {}, [["a", "b", "c"]]),
    ("shared file", [task("a", ["src/x.go"]), task("b", ["src/x.go"]), task("c", ["src/y.go"])], {}, [["a", "c"], ["b"]]),
    ("case and slashes", [task("a", ["Src\\Shop\\Cart.java"]), task("b", ["./src/shop/cart.java"])], {}, [["a"], ["b"]]),
    ("parallelism", [task(c, [c]) for c in "abcd"], {"max_parallel": 2}, [["a", "b"], ["c", "d"]]),
    ("tolerance", [task("a", ["src/x.rb"]), task("b", ["src/x.rb"])], {"tolerance": 1}, [["a", "b"]]),
    ("lockfile", [task("a", ["Cargo.lock"]), task("b", ["cargo.lock"])], {"tolerance": 1}, [["a"], ["b"]]),
    ("blocker first", [task("b", ["2"], blocked_by=["a"]), task("a", ["1"])], {}, [["a"], ["b"]]),
    ("unplanned alone", [task("a", ["1"]), task("b", []), task("c", ["3"])], {}, [["a", "c"], ["b"]]),
    ("unplanned independent", [task("a", ["1"]), task("b", []), task("c", ["3"])], {"unplanned_policy": "independent"}, [["a", "b", "c"]]),
    ("workspace counts", [task("a", ["src/a.kt"], actual_files=["src/s.kt"]), task("b", ["src/s.kt"])], {}, [["a"], ["b"]]),
    ("triangle", [task("a", ["x", "y"]), task("b", ["y", "z"]), task("c", ["z", "x"])], {}, [["a"], ["b"], ["c"]]),
]  # fmt: skip


@pytest.mark.parametrize(
    ("name", "tasks", "extra", "expected"), CASES, ids=[c[0] for c in CASES]
)
def test_waves(name, tasks, extra, expected):
    result = plan_execution_waves(tasks, [], options(**extra))
    assert waves(result) == [sorted(w) for w in expected]
    assert sorted(result["order"]) == sorted(c for w in expected for c in w)


def test_deterministic_whatever_the_order():
    tasks = [
        task("a", ["src/x.php", "composer.json"]),
        task("b", ["src/x.php"]),
        task("c", ["composer.json"]),
        task("d", ["src/z.php"]),
        task("e", []),
    ]
    first = plan_execution_waves(tasks, [], options())
    second = plan_execution_waves(list(reversed(tasks)), [], options())
    assert first["waves"] == second["waves"] and first["pairs"] == second["pairs"]


def test_most_constrained_first_and_merge_order():
    hub = task("hub", ["package.json", "src/a.ts", "src/b.ts"])
    result = plan_execution_waves(
        [task("a", ["src/a.ts"]), task("b", ["src/b.ts"]), hub], [], options()
    )
    assert result["waves"][0]["taskIds"] == ["hub"]
    assert (result["totalRisk"], result["residualRisk"]) == (2, 0)
    ordered = plan_execution_waves(
        [
            task("light", ["src/l.swift"]),
            task("heavy", ["Package.swift", "src/h.swift"]),
            task("next", ["package.swift"]),
        ],
        [],
        options(),
    )
    assert ordered["waves"][0]["taskIds"] == ["heavy", "light"]


def test_sub_tolerance_pairs_go_where_they_cost_least():
    result = plan_execution_waves(
        [task("a", ["x", "y"]), task("b", ["x", "y"]), task("c", ["x"])],
        [],
        options(tolerance=1),
    )
    assert len(result["waves"]) == 2 and result["residualRisk"] == 1


def test_cycles_and_what_waits_on_them_are_excluded():
    result = plan_execution_waves(
        [
            task("z", ["1"], blocked_by=["y"]),
            task("y", ["2"], blocked_by=["z"]),
            task("b", ["3"], blocked_by=["a"]),
            task("a", ["4"], blocked_by=["b"]),
            task("m", ["5"], blocked_by=["z"]),
            task("c", ["6"], blocked_by=["a"]),
            task("d", ["7"], blocked_by=["self", "gone"]),
            task("self", ["8"], blocked_by=["self"]),
        ],
        [],
        options(),
    )
    assert result["cycles"] == [["a", "b"], ["y", "z"]]
    assert [(e["taskId"], e["reason"]) for e in result["excluded"]] == [
        ("a", "cycle"),
        ("b", "cycle"),
        ("c", "blocked_by_cycle"),
        ("m", "blocked_by_cycle"),
        ("y", "cycle"),
        ("z", "cycle"),
    ]
    assert waves(result) == [["self"], ["d"]]


def test_a_long_chain_plans_without_recursion():
    chain = [
        task(f"t{i:04d}", [f"f{i}"], blocked_by=[f"t{i - 1:04d}"] if i else [])
        for i in range(1500)
    ]
    cycle = [
        task(f"c{i:04d}", [f"g{i}"], blocked_by=[f"c{(i + 1) % 1500:04d}"])
        for i in range(1500)
    ]
    result = plan_execution_waves(chain, [], options())
    assert len(result["waves"]) == 1500
    assert len(plan_execution_waves(cycle, [], options())["cycles"][0]) == 1500


def test_running_conflicts_and_drift():
    running = task(
        "run",
        ["src/a.dart", "package.json"],
        status="in_progress",
        actual_files=["src/a.dart", "lib/b.dart", "lib/c.dart", "lib/d.dart"],
    )
    small = task("small", ["src/x.dart"], actual_files=["src/x.dart", "src/y.dart"])
    unplanned = task("blind", [], actual_files=["z.dart"])
    result = plan_execution_waves(
        [
            small,
            task("q", ["lib/c.dart", "package.json"]),
            task("q1", ["lib/b.dart"]),
            unplanned,
        ],
        [running],
        options(),
    )
    assert result["drift"] == [
        {
            "taskId": "run",
            "extraCount": 3,
            "extraFiles": ["lib/b.dart", "lib/c.dart", "lib/d.dart"],
        }
    ]
    assert result["runningConflicts"] == [
        {"taskId": "q", "runningTaskId": "run", "score": 4},
        {"taskId": "q1", "runningTaskId": "run", "score": 1},
    ]
    assert {t["taskId"]: t["fileCount"] for t in result["tasks"]}["run"] == 5


def test_pairs_list_capped_files_merge_checks_and_links():
    files = [f"src/f{i}.c" for i in range(30)]
    result = plan_execution_waves([task("a", files), task("b", files)], [], options())
    assert result["pairs"][0]["level"] == "critical"
    assert len(result["pairs"][0]["sharedFiles"]) == 20
    checks = {
        pair_key("b", "a"): MergeOutcome("conflict", tuple(f"f{i}" for i in range(25)))
    }
    split = plan_execution_waves(
        [task("a", ["x.kt"]), task("b", ["y.kt"])], [], options(merge_checks=checks)
    )
    assert waves(split) == [["a"], ["b"]]
    assert split["pairs"][0]["mergeCheck"] == "conflict"
    assert len(split["pairs"][0]["conflictFiles"]) == 20
    fragile = plan_execution_waves(
        [task("a", ["api.ts"]), task("b", ["impl.ts"])],
        [],
        options(
            co_changes={
                "api.ts": frozenset({"impl.ts"}),
                "impl.ts": frozenset({"api.ts"}),
            }
        ),
    )
    assert fragile["pairs"][0]["fragileLinks"] == ["api.ts ↔ impl.ts"]
    used = [f"lib/module_{i}.ex" for i in range(5)]
    editor = task(
        "editor", used, code=build_spec_code([], "@@ -1 +1 @@\n-def old_helper do\n")
    )
    text = "\n".join(f"alias Lib.Module_{i}" for i in range(5)) + "\nold_helper()\n"
    user = task(
        "user", ["web/page.ex"], code=build_spec_code([("web/page.ex", text)], None)
    )
    linked = plan_execution_waves([editor, user], [], options())
    assert linked["pairs"][0]["score"] == MAX_CODE_WEIGHT
    assert len(linked["pairs"][0]["importLinks"]) == 5
    assert linked["pairs"][0]["symbolLinks"] == ["web/page.ex → old_helper"]


def test_an_empty_backlog():
    result = plan_execution_waves([], [], options())
    assert result["waves"] == [] and result["totalRisk"] == 0


# -- merge check -------------------------------------------------------------


def _merge_plan(tasks):
    return lambda checks: plan_execution_waves(
        tasks, [], options(tolerance=5, merge_checks=checks)
    )


def test_a_conflicting_test_merge_splits_the_wave_and_plans_again():
    tasks = [task("a", ["x"]), task("b", ["x"]), task("c", ["x"])]
    asked = []

    def merge(a, b, timeout):
        asked.append((a, b))
        return (
            MergeOutcome("conflict", ("x",))
            if {a, b} == {"A", "B"}
            else MergeOutcome("clean")
        )

    result, counts = plan_with_merge_checks(
        _merge_plan(tasks), {"a", "b", "c"}, lambda card: card.upper(), merge
    )
    assert any({"a", "b"} <= set(w["taskIds"]) for w in result["waves"]) is False
    assert counts["conflicts"] == 1 and counts["checked"] >= 2 and counts["failed"] == 0
    assert counts["unchecked"] == 0


def test_no_head_or_no_answer_counts_as_failed_and_clean_keeps_the_waves():
    tasks = [task("a", ["x"]), task("b", ["x"]), task("c", ["y"])]
    _result, counts = plan_with_merge_checks(
        _merge_plan(tasks),
        {"a", "b"},
        lambda card: None,
        lambda *a: MergeOutcome("clean"),
    )
    assert counts == {"checked": 0, "conflicts": 0, "unchecked": 0, "failed": 1}
    _result, counts = plan_with_merge_checks(
        _merge_plan(tasks), {"a", "b"}, lambda card: card, lambda *a: None
    )
    assert counts["failed"] == 1
    result, counts = plan_with_merge_checks(
        _merge_plan(tasks),
        {"a", "b"},
        lambda card: card,
        lambda *a: MergeOutcome("clean"),
    )
    assert counts["checked"] == 1 and result["pairs"][0]["mergeCheck"] == "clean"


def test_limits_leave_pairs_unchecked():
    many = [task(f"t{i:02d}", ["shared"]) for i in range(10)]
    plan = lambda checks: plan_execution_waves(  # noqa: E731
        many, [], options(max_parallel=10, tolerance=5, merge_checks=checks)
    )
    _result, counts = plan_with_merge_checks(
        plan, {t.id for t in many}, lambda c: c, lambda *a: MergeOutcome("clean")
    )
    assert counts["checked"] == MAX_MERGE_CHECKS and counts["unchecked"] == 45 - 24
    ticks = iter([0.0, 100.0, 100.0, 100.0])
    _result, late = plan_with_merge_checks(
        plan,
        {t.id for t in many},
        lambda c: c,
        lambda *a: MergeOutcome("clean"),
        clock=lambda: next(ticks),
    )
    assert late["checked"] == 0 and late["unchecked"] == 45

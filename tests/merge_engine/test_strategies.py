"""Deterministic merge strategies, and the check that none of them drops work.

Each strategy places a task's change by pattern. Where it cannot, the merge
must not report itself as done: the pipeline sends it to review instead of
writing a file without a task's lines.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from merge.auto_merger import AutoMerger, MergeContext
from merge.auto_merger.helpers import MergeHelpers
from merge.conflict_detector import ConflictDetector
from merge.conflict_resolver import ConflictResolver, build_explanation
from merge.faithfulness import describe, missing_changes
from merge.merge_pipeline import MergePipeline
from merge.types import (
    ChangeType,
    ConflictRegion,
    ConflictSeverity,
    MergeDecision,
    MergeResult,
    MergeStrategy,
    SemanticChange,
    TaskSnapshot,
)

T0 = datetime(2026, 11, 15, 9, 0, 0)


def change(kind, target="App", location="function:App", before=None, after=None):
    return SemanticChange(
        change_type=kind,
        target=target,
        location=location,
        line_start=1,
        line_end=1,
        content_before=before,
        content_after=after,
    )


def snap(task_id, *changes, minutes=0):
    return TaskSnapshot(
        task_id=task_id,
        task_intent=f"intent of {task_id}",
        started_at=T0 + timedelta(minutes=minutes),
        semantic_changes=list(changes),
    )


def conflict(strategy, location="function:App", tasks=("t1", "t2")):
    return ConflictRegion(
        file_path="src/App.jsx",
        location=location,
        tasks_involved=list(tasks),
        change_types=[],
        severity=ConflictSeverity.LOW,
        can_auto_merge=True,
        merge_strategy=strategy,
    )


def run(strategy, baseline, *snapshots, file_path="src/App.jsx", location=None):
    region = conflict(strategy, location or "function:App")
    context = MergeContext(
        file_path=file_path,
        baseline_content=baseline,
        task_snapshots=list(snapshots),
        conflict=region,
    )
    return AutoMerger().merge(context, strategy)


COMPONENT = """import React from 'react';

function App() {
  return (
    <div>Hello</div>
  );
}

export default App;
"""


class TestHooks:
    def test_array_destructuring_is_kept_with_the_hook(self):
        added = change(
            ChangeType.ADD_HOOK_CALL,
            after="  const [count, setCount] = useState(0);",
        )
        assert (
            MergeHelpers.extract_hook_call(added)
            == "const [count, setCount] = useState(0);"
        )

    @pytest.mark.parametrize(
        "line, hook",
        [
            ("const { user } = useAuth();", "const { user } = useAuth();"),
            ("const theme = useTheme()", "const theme = useTheme()"),
            ("useEffect(load);", "useEffect(load);"),
            ("return 1;", None),
        ],
    )
    def test_hook_call_shapes(self, line, hook):
        assert (
            MergeHelpers.extract_hook_call(change(ChangeType.ADD_HOOK_CALL, after=line))
            == hook
        )

    def test_a_change_without_content_has_no_hook(self):
        assert MergeHelpers.extract_hook_call(change(ChangeType.ADD_HOOK_CALL)) is None

    def test_hooks_first_keeps_the_other_tasks_edit(self):
        before = "    <div>Hello</div>"
        after = "    <div>Hello, world</div>"
        result = run(
            MergeStrategy.HOOKS_FIRST,
            COMPONENT,
            snap(
                "t1",
                change(
                    ChangeType.ADD_HOOK_CALL, after="const [n, setN] = useState(0);"
                ),
            ),
            snap("t2", change(ChangeType.MODIFY_FUNCTION, before=before, after=after)),
        )
        assert result.success
        assert (
            "function App() {\n  const [n, setN] = useState(0);"
            in result.merged_content
        )
        assert "<div>Hello, world</div>" in result.merged_content

    @pytest.mark.parametrize(
        "source",
        [
            "const App = () => {\n  return null;\n};\n",
            "const App = async (props) => {\n  return null;\n};\n",
            "let App = function (props) {\n  return null;\n};\n",
        ],
    )
    def test_hooks_go_into_arrow_and_function_expressions(self, source):
        merged = MergeHelpers.insert_hooks_into_function(source, "App", ["useX();"])
        assert merged.splitlines()[1] == "  useX();"

    def test_an_unknown_function_or_no_hooks_changes_nothing(self):
        assert (
            MergeHelpers.insert_hooks_into_function(COMPONENT, "Other", ["useX();"])
            == COMPONENT
        )
        assert (
            MergeHelpers.insert_hooks_into_function(COMPONENT, "App", []) == COMPONENT
        )

    def test_hooks_then_wrap_closes_the_wrapper(self):
        result = run(
            MergeStrategy.HOOKS_THEN_WRAP,
            COMPONENT,
            snap(
                "t1",
                change(ChangeType.ADD_HOOK_CALL, after="const { user } = useAuth();"),
            ),
            snap(
                "t2",
                change(
                    ChangeType.WRAP_JSX,
                    after='<ThemeProvider theme="dark">\n<div>Hello</div>\n</ThemeProvider>',
                ),
            ),
        )
        assert result.success
        merged = result.merged_content
        assert (
            '<ThemeProvider theme="dark">\n      <div>Hello</div>\n    </ThemeProvider>\n  );'
            in merged
        )
        assert merged.count("<ThemeProvider") == merged.count("</ThemeProvider>") == 1
        assert "const { user } = useAuth();" in merged

    def test_a_wrapper_without_props_or_a_return(self):
        assert (
            "<Box>\n      <div>Hello</div>\n    </Box>"
            in MergeHelpers.wrap_function_return(COMPONENT, "App", "Box", "")
        )
        no_jsx = "function App() {\n  return value;\n}\n"
        assert MergeHelpers.wrap_function_return(no_jsx, "App", "Box", "") == no_jsx
        assert (
            MergeHelpers.wrap_function_return(COMPONENT, "Nope", "Box", "") == COMPONENT
        )
        unclosed = "function App() {\n  return (<div>\n"
        assert MergeHelpers.wrap_function_return(unclosed, "App", "Box", "") == unclosed

    def test_the_wrap_is_scoped_to_the_named_function(self):
        two = (
            "function Header() {\n  return (\n    <h1/>\n  );\n}\n"
            "function App() {\n  return (\n    <main/>\n  );\n}\n"
        )
        merged = MergeHelpers.wrap_function_return(two, "App", "Shell", "")
        assert "<Shell>\n      <main/>\n    </Shell>" in merged
        assert "<Shell>\n      <h1/>" not in merged

    def test_a_wrap_change_without_a_tag(self):
        assert (
            MergeHelpers.extract_jsx_wrapper(change(ChangeType.WRAP_JSX, after="text"))
            is None
        )
        assert MergeHelpers.extract_jsx_wrapper(change(ChangeType.WRAP_JSX)) is None


class TestAppend:
    def test_functions_go_before_the_default_export(self):
        result = run(
            MergeStrategy.APPEND_FUNCTIONS,
            COMPONENT,
            snap("t1", change(ChangeType.ADD_FUNCTION, after="function a() {}")),
            snap("t2", change(ChangeType.ADD_FUNCTION, after="function b() {\n}")),
        )
        lines = result.merged_content.splitlines()
        assert lines.index("function a() {}") < lines.index("function b() {")
        assert lines.index("function b() {") < lines.index("export default App;")

    def test_methods_go_into_their_class(self):
        source = "class Cart {\n  total() { return 0; }\n}\n"
        result = run(
            MergeStrategy.APPEND_METHODS,
            source,
            snap(
                "t1",
                change(ChangeType.ADD_METHOD, target="Cart.clear", after="clear() {}"),
            ),
            snap("t2", change(ChangeType.ADD_METHOD, target="loose", after="x() {}")),
            file_path="src/cart.js",
            location="class:Cart",
        )
        assert result.merged_content == (
            "class Cart {\n  total() { return 0; }\n\n\n  clear() {}}\n"
        )

    def test_statements_are_appended(self):
        result = run(
            MergeStrategy.APPEND_STATEMENTS,
            "const a = 1;",
            snap("t1", change(ChangeType.ADD_VARIABLE, after="const b = 2;")),
            snap("t2", change(ChangeType.MODIFY_FUNCTION, before="x", after="y")),
            location="file_top",
        )
        assert result.merged_content == "const a = 1;\nconst b = 2;"


class TestOrdering:
    def test_by_dependency_applies_hooks_then_wraps(self):
        result = run(
            MergeStrategy.ORDER_BY_DEPENDENCY,
            COMPONENT,
            snap(
                "t1",
                change(ChangeType.WRAP_JSX, target="src.App", after="<Box>"),
                change(ChangeType.ADD_HOOK_CALL, target="src.App", after="useA();"),
            ),
            snap("t2", change(ChangeType.ADD_HOOK_CALL, target="App", after="useB();")),
            snap("t3", change(ChangeType.WRAP_JSX, target="App", after="no tag")),
            snap("t4", change(ChangeType.ADD_HOOK_CALL, target="App", after="nothing")),
        )
        merged = result.merged_content
        assert "useA();" in merged and "useB();" in merged
        assert "<Box>\n      <div>Hello</div>\n    </Box>" in merged

    def test_topological_order_puts_imports_and_hooks_first(self):
        ordered = MergeHelpers.topological_sort_changes(
            [
                snap(
                    "t1",
                    change(ChangeType.MODIFY_FUNCTION, after="m"),
                    change(ChangeType.ADD_DECORATOR, after="d"),
                    change(ChangeType.ADD_IMPORT, after="i"),
                    change(ChangeType.ADD_HOOK_CALL, after="h"),
                )
            ]
        )
        assert [c.content_after for c in ordered] == ["i", "h", "m", "d"]

    def test_by_time_replays_the_earlier_task_first(self):
        result = run(
            MergeStrategy.ORDER_BY_TIME,
            "x = 1\n",
            snap(
                "late",
                change(ChangeType.FORMATTING_ONLY, before="x = 2", after="x = 3"),
                minutes=5,
            ),
            snap(
                "early",
                change(ChangeType.FORMATTING_ONLY, before="x = 1", after="x = 2"),
            ),
            snap("add", change(ChangeType.ADD_COMMENT, after="# note"), minutes=9),
            file_path="a.py",
        )
        assert result.merged_content == "x = 3\n"


class TestProps:
    def test_the_last_tasks_props_are_applied(self):
        result = run(
            MergeStrategy.COMBINE_PROPS,
            "<Button size={1} />",
            snap(
                "t1",
                change(
                    ChangeType.MODIFY_JSX_PROPS,
                    before="<Button size={1} />",
                    after="<Button size={1} color={red} />",
                ),
            ),
        )
        assert result.merged_content == "<Button size={1} color={red} />"

    def test_new_props_are_the_ones_not_there_before(self):
        props = MergeHelpers.extract_new_props(
            change(
                ChangeType.MODIFY_JSX_PROPS,
                before="<B a={1} />",
                after="<B a={2} b={x} />",
            )
        )
        assert props == [("b", "x")]
        assert MergeHelpers.extract_new_props(change(ChangeType.MODIFY_JSX_PROPS)) == []


class TestHelpers:
    @pytest.mark.parametrize(
        "lines, ext, end",
        [
            (["import a", "from b import c", "", "x = 1"], ".py", 2),
            (
                ["// header", "import a from 'a';", "export { b };", "const c = 1;"],
                ".ts",
                3,
            ),
            (["package main", 'import "fmt"'], ".go", 0),
        ],
    )
    def test_import_section_end(self, lines, ext, end):
        assert MergeHelpers.find_import_section_end(lines, ext) == end

    def test_content_change_needs_its_old_text(self):
        assert MergeHelpers.apply_content_change("a b a", "a", "c") == "c b a"
        assert MergeHelpers.apply_content_change("a b", "z", "c") == "a b"
        assert MergeHelpers.apply_content_change("a b", None, "c") == "a b"

    def test_no_export_means_no_insert_position(self):
        assert MergeHelpers.find_function_insert_position("x = 1\n", ".py") is None
        assert (
            MergeHelpers.find_function_insert_position("a\nmodule.exports = a;", ".js")
            == 1
        )

    def test_a_class_that_never_closes_is_left_alone(self):
        assert MergeHelpers.insert_methods_into_class(
            "class A {\n  x() {", "A", ["y() {}"]
        ) == ("class A {\n  x() {")


class TestMerger:
    def test_an_unhandled_strategy_fails(self):
        result = run(MergeStrategy.AI_REQUIRED, COMPONENT, snap("t1"))
        assert result.decision is MergeDecision.FAILED
        assert "No handler" in result.error
        assert AutoMerger().can_handle(MergeStrategy.AI_REQUIRED) is False

    def test_a_strategy_that_raises_fails_the_merge(self, monkeypatch):
        def boom(lines, ext):
            raise ValueError("bad input")

        monkeypatch.setattr(MergeHelpers, "find_import_section_end", staticmethod(boom))
        result = run(
            MergeStrategy.COMBINE_IMPORTS,
            COMPONENT,
            snap("t1", change(ChangeType.ADD_IMPORT, after="import x from 'x';")),
        )
        assert result.decision is MergeDecision.FAILED
        assert "bad input" in result.error


class TestFaithfulness:
    def test_every_added_line_must_be_in_the_merge(self):
        kept = change(
            ChangeType.ADD_FUNCTION, target="a", after="def a():\n    return 1"
        )
        lost = change(
            ChangeType.ADD_METHOD, target="Cart.clear", after="def clear(self): ..."
        )
        removal = change(ChangeType.REMOVE_IMPORT, before="import os")
        missing = missing_changes(
            "x = 1\r\ndef a():\r\n    return 1\r\n",
            [snap("t1", kept, removal), snap("t2", lost)],
        )
        assert missing == [("t2", "add_method Cart.clear")]
        assert describe(missing) == (
            "Changes not placed by the automatic merge: t2: add_method Cart.clear"
        )

    def test_lines_only_the_diff_knows_about_count_too(self):
        """A changed function body yields no semantic change; its diff still says it."""
        body = snap("t1")
        body.raw_diff = (
            "--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n def total():\n"
            "-    return 0\n+    return sum(items)\n+\n"
        )
        assert missing_changes("def total():\n    return 0\n", [body]) == [
            ("t1", "1 added line(s) from its diff")
        ]
        assert missing_changes("def total():\n    return sum(items)\n", [body]) == []


class StubAI:
    def __init__(self, result: MergeResult):
        self.result = result
        self.calls = 0

    def resolve_conflict(self, conflict, baseline_code, task_snapshots):
        self.calls += 1
        return self.result


def ai_result(content, success=True):
    return MergeResult(
        decision=MergeDecision.AI_MERGED if success else MergeDecision.FAILED,
        file_path="src/App.jsx",
        merged_content=content,
        ai_calls_made=1,
        tokens_used=120,
    )


class TestConflictResolver:
    def medium(self, location="function:App"):
        region = conflict(None, location)
        region.can_auto_merge = False
        region.severity = ConflictSeverity.MEDIUM
        region.reason = "both edit App"
        return region

    def test_an_ai_region_that_cannot_be_placed_stays_open(self):
        ai = StubAI(ai_result("function Gone() {}"))
        resolver = ConflictResolver(AutoMerger(), ai, enable_ai=True)
        result = resolver.resolve_conflicts(
            "src/App.jsx",
            COMPONENT,
            [snap("t1"), snap("t2")],
            [self.medium("function:Missing")],
        )
        assert ai.calls == 1
        assert result.decision is MergeDecision.FAILED
        assert result.merged_content is None
        assert "need human review" in result.explanation

    def test_an_ai_region_replaces_the_function(self):
        merged_app = "function App() {\n  return (\n    <main/>\n  );\n}"
        ai = StubAI(ai_result(merged_app))
        progress = []
        resolver = ConflictResolver(AutoMerger(), ai)
        result = resolver.resolve_conflicts(
            "src/App.jsx",
            COMPONENT,
            [snap("t1"), snap("t2")],
            [self.medium()],
            progress_callback=lambda **kw: progress.append(kw["percent"]),
        )
        assert result.decision is MergeDecision.AI_MERGED
        assert "<main/>" in result.merged_content
        assert result.tokens_used == 120
        assert progress == [75]

    def test_a_failed_ai_answer_leaves_the_conflict(self):
        resolver = ConflictResolver(
            AutoMerger(), StubAI(ai_result(None, success=False))
        )
        result = resolver.resolve_conflicts(
            "src/App.jsx", COMPONENT, [snap("t1")], [self.medium()]
        )
        assert result.decision is MergeDecision.FAILED

    def test_some_resolved_some_not_needs_review(self):
        imports = conflict(MergeStrategy.COMBINE_IMPORTS, "file_top")
        stuck = self.medium()
        resolver = ConflictResolver(AutoMerger(), None, enable_ai=False)
        result = resolver.resolve_conflicts(
            "src/App.jsx",
            COMPONENT,
            [snap("t1", change(ChangeType.ADD_IMPORT, after="import x from 'x';"))],
            [imports, stuck],
        )
        assert result.decision is MergeDecision.NEEDS_HUMAN_REVIEW
        assert "import x from 'x';" in result.merged_content

    def test_explanations_are_capped_at_five(self):
        many = [
            conflict(MergeStrategy.COMBINE_IMPORTS, f"function:F{i}") for i in range(7)
        ]
        text = build_explanation(many, many)
        assert "Resolved 7 conflict(s):" in text and text.count("... and 2 more") == 2
        assert build_explanation([], []) == "No conflicts"
        unnamed = conflict(None)
        assert "function:App: auto" in build_explanation([unnamed], [])


class TestPipeline:
    def pipeline(self):
        return MergePipeline(
            ConflictDetector(), ConflictResolver(AutoMerger(), None, False)
        )

    def test_one_task_is_copied_from_its_worktree(self):
        progress = []
        result = self.pipeline().merge_file(
            "src/cart.py",
            "class Cart:\n    pass\n",
            [
                snap(
                    "t1",
                    change(
                        ChangeType.ADD_METHOD,
                        target="Cart.clear",
                        after="    def clear(self): ...",
                    ),
                )
            ],
            progress_callback=lambda **kw: progress.append(kw["stage"]),
        )
        assert result.decision is MergeDecision.DIRECT_COPY
        assert result.merged_content is None
        assert progress

    def test_compatible_changes_are_combined(self):
        result = self.pipeline().merge_file(
            "app.py",
            "import os\n\nx = 1\n",
            [
                snap(
                    "t1",
                    change(
                        ChangeType.ADD_IMPORT,
                        target="sys",
                        location="file_top",
                        after="import sys",
                    ),
                ),
                snap(
                    "t2",
                    change(
                        ChangeType.ADD_FUNCTION,
                        target="f",
                        location="function:f",
                        after="def f():\n    return 1",
                    ),
                ),
            ],
        )
        assert result.decision is MergeDecision.AUTO_MERGED
        assert "import sys" in result.merged_content
        assert "def f():" in result.merged_content

    def test_a_combine_that_drops_a_change_goes_to_review(self):
        result = self.pipeline().merge_file(
            "app.py",
            "import os\n\nclass Cart:\n    pass\n",
            [
                snap(
                    "t1",
                    change(
                        ChangeType.ADD_IMPORT,
                        target="sys",
                        location="file_top",
                        after="import sys",
                    ),
                ),
                snap(
                    "t2",
                    change(
                        ChangeType.MODIFY_FUNCTION,
                        target="total",
                        location="function:total",
                        before="def total(): return 0",
                        after="def total(): return 1",
                    ),
                ),
            ],
        )
        assert result.decision is MergeDecision.NEEDS_HUMAN_REVIEW
        assert result.explanation == (
            "Changes not placed by the automatic merge: t2: modify_function total"
        )

    def test_hooks_of_two_tasks_go_into_their_function(self):
        hook_a = change(
            ChangeType.ADD_HOOK_CALL, target="useA", after="const a = useA();"
        )
        hook_b = change(
            ChangeType.ADD_HOOK_CALL, target="useB", after="const b = useB();"
        )
        result = self.pipeline().merge_file(
            "src/App.jsx", COMPONENT, [snap("t1", hook_a), snap("t2", hook_b)]
        )
        assert result.decision is MergeDecision.AUTO_MERGED
        body = result.merged_content.split("function App() {", 1)[1]
        assert body.index("const b = useB();") < body.index("return (")
        assert body.index("const a = useA();") < body.index("return (")

    @pytest.mark.parametrize(
        "added",
        [
            change(
                ChangeType.ADD_VARIABLE,
                target="x",
                location="function:App",
                after="let x = 1;",
            ),
            change(
                ChangeType.ADD_HOOK_CALL,
                target="App",
                location="function:Gone",
                after="useX();",
            ),
        ],
    )
    def test_an_addition_with_no_known_place_goes_to_review(self, added):
        result = self.pipeline().merge_file(
            "src/App.jsx",
            COMPONENT,
            [
                snap("t1", added),
                snap(
                    "t2",
                    change(
                        ChangeType.ADD_IMPORT,
                        target="y",
                        location="file_top",
                        after="import y from 'y';",
                    ),
                ),
            ],
        )
        assert result.decision is MergeDecision.NEEDS_HUMAN_REVIEW
        assert result.merged_content.rstrip().endswith("export default App;")

    def test_file_level_and_class_additions(self):
        source = "class Cart {\n  total() { return 0; }\n}\n"
        result = self.pipeline().merge_file(
            "src/cart.js",
            source,
            [
                snap(
                    "t1",
                    change(
                        ChangeType.ADD_METHOD,
                        target="Cart.clear",
                        location="class:Cart",
                        after="clear() {}",
                    ),
                ),
                snap(
                    "t2",
                    change(
                        ChangeType.ADD_CONSTANT,
                        target="MAX",
                        location="file_top",
                        after="const MAX = 3;",
                    ),
                ),
            ],
        )
        assert result.decision is MergeDecision.AUTO_MERGED
        assert "clear() {}}" in result.merged_content
        assert result.merged_content.endswith("const MAX = 3;")

    def test_a_body_change_the_analyzer_did_not_see_goes_to_review(self):
        """Two tasks, one adds an import, the other edits a body: the body edit
        exists only in its diff, and a merge from the baseline would lose it."""
        importer = snap(
            "t1",
            change(
                ChangeType.ADD_IMPORT,
                target="sys",
                location="file_top",
                after="import sys",
            ),
        )
        editor = snap(
            "t2",
            change(
                ChangeType.ADD_IMPORT,
                target="re",
                location="file_top",
                after="import re",
            ),
        )
        editor.raw_diff = "+++ b/app.py\n+    return sum(items)\n"
        result = self.pipeline().merge_file(
            "app.py", "import os\n\ndef total():\n    return 0\n", [importer, editor]
        )
        assert result.decision is MergeDecision.NEEDS_HUMAN_REVIEW
        assert "t2: 1 added line(s) from its diff" in result.explanation

"""What a task changed in a file, in terms two tasks can collide on.

The merge preview compares these changes between tasks, so a rewritten
function has to be named as such in every language a project may use, not only
an added one.
"""

from __future__ import annotations

import pytest
from merge import ChangeType, SemanticAnalyzer


def changes(path: str, before: str, after: str) -> list[tuple[str, str, int]]:
    analysis = SemanticAnalyzer().analyze_diff(path, before, after)
    return [(c.change_type.value, c.target, c.line_start) for c in analysis.changes]


REWRITES = {
    "app.py": (
        "import os\n\n\ndef run():\n    return 1\n\n\ndef stop():\n    return 0\n",
        "import os\n\n\ndef run():\n    return 2\n\n\ndef stop():\n    return 0\n",
        5,
    ),
    "app.ts": (
        "import a from 'a';\n\nfunction run() {\n  return 1;\n}\n\n"
        "const stop = () => {\n  return 0;\n};\n",
        "import a from 'a';\n\nfunction run() {\n  return 2;\n}\n\n"
        "const stop = () => {\n  return 0;\n};\n",
        4,
    ),
    "Service.cs": (
        "using System;\n\npublic class Service\n{\n"
        "    public int Run()\n    {\n        return 1;\n    }\n\n"
        "    public static int Stop()\n    {\n        return 0;\n    }\n}\n",
        "using System;\n\npublic class Service\n{\n"
        "    public int Run()\n    {\n        return 2;\n    }\n\n"
        "    public static int Stop()\n    {\n        return 0;\n    }\n}\n",
        7,
    ),
    "main.go": (
        'package main\n\nimport "fmt"\n\nfunc run() int {\n\treturn 1\n}\n\n'
        "func stop() int {\n\treturn 0\n}\n",
        'package main\n\nimport "fmt"\n\nfunc run() int {\n\treturn 2\n}\n\n'
        "func stop() int {\n\treturn 0\n}\n",
        6,
    ),
}


@pytest.mark.parametrize("path", sorted(REWRITES))
def test_a_rewritten_function_is_named_and_its_neighbour_is_not(path):
    before, after, line = REWRITES[path]
    name = "Run" if path.endswith(".cs") else "run"

    assert changes(path, before, after) == [("modify_function", name, line)]


def test_a_python_function_ends_where_its_body_does():
    before = "def run():\n    return 1\n\nVALUE = 1\n"
    after = "def run():\n    return 1\n\nVALUE = 2\n"

    assert changes("app.py", before, after) == []


def test_a_method_inside_a_python_function_is_the_one_rewritten():
    before = "def outer():\n    def inner():\n        return 1\n    return inner\n"
    after = "def outer():\n    def inner():\n        return 2\n    return inner\n"

    assert changes("app.py", before, after) == [("modify_function", "inner", 3)]


def test_added_and_removed_functions_sit_at_their_own_lines():
    before = "def old():\n    return 1\n"
    after = "def new():\n    return 1\n"

    assert changes("app.py", before, after) == [
        ("add_function", "new", 1),
        ("remove_function", "old", 1),
    ]


@pytest.mark.parametrize(
    ("path", "before", "after", "statement"),
    [
        ("app.py", "x = 1\n", "from os import path\nx = 1\n", "from os import path"),
        (
            "app.tsx",
            "const x = 1;\n",
            "import React from 'react';\nconst x = 1;\n",
            None,
        ),
        ("Service.cs", "class A {}\n", "using System.Linq;\nclass A {}\n", None),
        ("lib.rs", "fn a() {}\n", "use std::io;\nfn a() {}\n", None),
        ("App.java", "class A {}\n", "import java.util.List;\nclass A {}\n", None),
        ("main.c", "int a;\n", "#include <stdio.h>\nint a;\n", None),
    ],
)
def test_an_added_import_is_recorded_in_each_language(path, before, after, statement):
    analysis = SemanticAnalyzer().analyze_diff(path, before, after)

    expected = statement or after.splitlines()[0]
    assert analysis.imports_added == {expected}
    assert [c.change_type for c in analysis.changes] == [ChangeType.ADD_IMPORT]


def test_a_removed_import_is_not_also_a_rewrite():
    before = "def run():\n    import os\n    return os.sep\n"
    after = "def run():\n    return '/'\n"

    analysis = SemanticAnalyzer().analyze_diff("app.py", before, after)

    assert analysis.imports_removed == {"import os"}
    assert analysis.functions_modified == {"run"}


def test_windows_line_endings_read_like_unix_ones():
    before = "def run():\r\n    return 1\r\n"
    after = "def run():\r\n    return 2\r\n"

    assert changes("app.py", before, after) == [("modify_function", "run", 2)]


def test_an_unknown_language_still_counts_its_changed_lines():
    analysis = SemanticAnalyzer().analyze_diff("notes.txt", "a\nb\n", "a\nc\n")

    assert analysis.changes == []
    assert analysis.total_lines_changed == 2


def test_a_removed_line_that_starts_with_two_dashes_is_a_change():
    before = "function run(i) {\n--i;\n  return i;\n}\n"
    after = "function run(i) {\n  return i;\n}\n"

    analysis = SemanticAnalyzer().analyze_diff("app.ts", before, after)

    assert analysis.functions_modified == {"run"}
    assert analysis.total_lines_changed == 1

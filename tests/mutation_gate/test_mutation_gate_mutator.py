"""The generic mutator: the expected inversions per stack, none in a comment or a string."""

from __future__ import annotations

import pytest
from mutation_gate.mutator import language_of, mask_code, mutants_for


def _described(path: str, text: str, lines=None) -> list[tuple[int, str]]:
    wanted = lines or set(range(1, text.count("\n") + 2))
    return sorted((m.line, m.description) for m in mutants_for(path, text, wanted))


def test_csharp():
    code = (
        "public bool CanShip(Order o) {\n"
        "    // if (o.Total == 0) return false;\n"
        '    var label = "a >= b && c";\n'
        "    return o.Total >= 10 && o.Lines.Count != 0;\n"
        "}\n"
    )
    assert _described("Order.cs", code) == [
        (4, "!= becomes =="),
        (4, "&& becomes ||"),
        (4, ">= becomes >"),
    ]


def test_csharp_verbatim_string_and_generics():
    code = 'var p = @"C:\\a == b";\nvar xs = new List<int>();\nreturn a < b;\n'
    assert _described("A.cs", code) == [(3, "< becomes <=")]


def test_typescript_template_and_arrow():
    code = (
        "const ok = (a: number) => a > 0;\n"
        "const s = `${a} === ${b}`;\n"
        "/* a == b */ export const eq = a === b || flag;\n"
    )
    assert _described("ok.ts", code) == [
        (1, "> becomes >="),
        (3, "=== becomes !=="),
        (3, "|| becomes &&"),
    ]


def test_python_words_and_docstrings():
    code = (
        "def adult(age):\n"
        '    """age >= 18 and True"""\n'
        "    # age == 0\n"
        "    return age >= 18 and not False\n"
    )
    assert _described("people.py", code) == [
        (4, ">= becomes >"),
        (4, "False becomes True"),
        (4, "and becomes or"),
    ]


def test_go_channels_and_raw_strings():
    code = "v := <-ch\nq := `a == b`\nif a - b < 0 {\n"
    assert _described("calc.go", code) == [(3, "- becomes +"), (3, "< becomes <=")]


def test_dart_and_php():
    dart = "bool big(int n) => n > 100 || isVip;\n// n == 1\n"
    assert _described("big.dart", dart) == [(1, "> becomes >="), (1, "|| becomes &&")]
    php = "<?php\n# $a == $b\nreturn $a == $b ? true : false; // $a != $b\n"
    assert _described("a.php", php) == [
        (3, "== becomes !="),
        (3, "false becomes true"),
        (3, "true becomes false"),
    ]


def test_rust_lifetimes_and_chars_are_not_strings():
    code = "fn f<'a>(x: &'a str, c: char) -> bool { c == 'x' && x.len() > 2 }\n"
    assert _described("lib.rs", code) == [
        (1, "&& becomes ||"),
        (1, "== becomes !="),
        (1, "> becomes >="),
    ]


def test_only_the_asked_lines_and_not_imports():
    code = "import a == b\nx = 1 + 2\ny = 3 + 4\n"
    assert _described("m.py", code, {1, 3}) == [(3, "+ becomes -")]


def test_a_mutant_applies_to_its_column_only():
    code = "a = x == 1\nb = x == 2\n"
    second = next(m for m in mutants_for("m.py", code, {2}))
    assert second.apply(code) == "a = x == 1\nb = x != 2\n"
    with pytest.raises(ValueError):
        second.apply("a = x == 1\nchanged\n")


def test_unknown_languages_are_not_mutated_and_masking_keeps_lengths():
    assert language_of("README.md") is None
    assert mutants_for("notes.txt", "a == b", {1}) == []
    text = 'x = "a\\n == b" # c == d\ny == z'
    masked = mask_code(text, "hash")
    assert len(masked) == len(text) and masked.count("\n") == 1
    assert "==" not in masked.split("\n")[0] and "==" in masked.split("\n")[1]

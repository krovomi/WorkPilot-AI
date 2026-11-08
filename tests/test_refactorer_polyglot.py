"""agents/refactorer_polyglot.py: code smells for every stack beyond Python."""

from __future__ import annotations

import pytest
from agents.refactorer import RefactoringAgent, SmellDetector, SmellType
from agents.refactorer_polyglot import (
    detect_polyglot_smells,
    guess_language,
    snippet_path,
    supported_languages,
)

CSHARP = """using System;
namespace Shop;

public class OrderService
{
    public decimal ComputeTotal(Order o, Customer c, bool vip, int qty, string code, DateTime at)
    {
        if (o != null)
        {
            foreach (var l in o.Lines)
            {
                if (l.Qty > 0)
                {
                    if (vip)
                    {
                        if (code == "X") { return l.Price * 0.85m; }
                    }
                }
            }
        }
        return 42;
    }
}
"""

GO = """package shop

import "fmt"

func Total(items []Item) int {
\tsum := 0
\tfor _, it := range items {
\t\tsum += it.Price * 7
\t}
\tfmt.Println(sum)
\treturn sum
}
"""

RUBY = """class Cart
  def total(items)
    items.each do |i|
      if i.ok
        unless i.free
          if i.qty > 3
            if i.vip
              puts i
            end
          end
        end
      end
    end
  end
end
"""

KOTLIN = """package shop

class Basket {
    fun add(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int): Int {
        return a + b + c + d + e + f
    }
}
"""

RUST = """pub fn parse(input: &str) -> Result<u32, String> {
    let mut total = 0;
    for part in input.split(',') {
        total += part.trim().parse::<u32>().unwrap() * 13;
    }
    Ok(total)
}
"""


def _types(smells) -> set[str]:
    return {s.smell_type.value for s in smells}


def test_csharp_allman_nesting_parameters_docs_and_numbers():
    smells = SmellDetector().detect_from_source(CSHARP, "Shop.cs")
    by_type = {s.smell_type: s for s in smells}
    assert by_type[SmellType.DEEP_NESTING].symbol_name == "OrderService.ComputeTotal"
    assert by_type[SmellType.DEEP_NESTING].metric_value == 5
    assert by_type[SmellType.LONG_PARAMETER_LIST].metric_value == 6
    assert SmellType.MISSING_DOCSTRING in by_type
    numbers = {s.message for s in smells if s.smell_type == SmellType.MAGIC_NUMBER}
    assert any("0.85" in m for m in numbers) and any("42" in m for m in numbers)


def test_ruby_blocks_close_on_end():
    smells = SmellDetector().detect_from_source(RUBY, language="ruby")
    nesting = [s for s in smells if s.smell_type == SmellType.DEEP_NESTING]
    assert nesting and nesting[0].symbol_name == "Cart.total"


def test_go_kotlin_and_rust_are_read_by_their_own_syntax():
    assert {"missing_docstring", "magic_number"} <= _types(
        detect_polyglot_smells(GO, "go", SmellDetector())
    )
    assert "long_parameter_list" in _types(
        detect_polyglot_smells(KOTLIN, "kotlin", SmellDetector())
    )
    assert "magic_number" in _types(
        detect_polyglot_smells(RUST, "rust", SmellDetector())
    )


def test_a_clean_snippet_has_no_invented_smell():
    clean = "/// <summary>Adds.</summary>\npublic int Add(int a, int b)\n{\n    return a + b;\n}\n"
    assert detect_polyglot_smells(clean, "csharp", SmellDetector()) == []


def test_python_still_goes_through_ast():
    source = "def f(a, b, c, d, e, f):\n    return 1\n"
    smells = SmellDetector().detect_from_source(source)
    assert "long_parameter_list" in _types(smells)


@pytest.mark.parametrize(
    ("source", "language"),
    [
        (CSHARP, "csharp"),
        (GO, "go"),
        (RUBY, "ruby"),
        (KOTLIN, "kotlin"),
        (RUST, "rust"),
        ("<?php\nfunction f($a) { return $a->x(); }\n", "php"),
        ("import 'package:flutter/material.dart';\nvoid main() {}\n", "dart"),
        ("#include <vector>\nint main() { std::vector<int> v; }\n", "cpp"),
        ("export const add = (a: number, b: number) => a + b;\n", "typescript"),
        ("import os\n\ndef f(x):\n    return self.x\n", "python"),
    ],
)
def test_guess_language_of_a_pasted_snippet(source, language):
    assert guess_language(source) == language


def test_guess_language_is_empty_when_unsure():
    assert guess_language("hello world") == ""


def test_snippet_path_and_language_list():
    assert snippet_path("csharp") == "snippet.cs"
    assert snippet_path("nope") == "snippet.txt"
    ids = {lang["id"] for lang in supported_languages()}
    assert {
        "python",
        "csharp",
        "java",
        "go",
        "rust",
        "swift",
        "php",
        "ruby",
        "dart",
    } <= ids


def test_agent_proposals_follow_the_language():
    proposals = RefactoringAgent().propose_refactoring(
        source=CSHARP, file_path="snippet.cs", language="csharp"
    )
    patterns = {p.pattern.value for p in proposals}
    assert {"introduce_parameter_object", "simplify_conditional"} <= patterns

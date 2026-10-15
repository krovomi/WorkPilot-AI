"""harness.domain.code_chunks: code split by symbol, every line kept somewhere.

`search_code` ranks chunks: a function, a method or a class head, with its path
and symbol written in front. Python is split by `ast`; TypeScript/JavaScript,
C#, Java, Go and Rust by declaration patterns and braces counted outside strings
and comments; anything else by fixed windows.
"""

from __future__ import annotations

import re

import pytest
from harness.domain.code_chunks import (
    MAX_CHUNK_LINES,
    WINDOW_LINES,
    Chunk,
    chunk_file,
    language_of,
)

PYTHON = """\
import os

# The budget check.
@decorator
def over_budget(spent, cap):
    return spent > cap


class Ledger:
    \"\"\"A ledger.\"\"\"

    def add(self, call):
        self.calls.append(call)

    async def flush(self):
        pass

    total = 0
"""

TYPESCRIPT = """\
import { x } from "y";

export function pageItems(items: string[]): string[] {
  const s = "}{";
  return items;
}

export const useThing = (a: number) => {
  return a + 1;
};

export class Store extends Base {
  private count = 0;

  constructor(a: number) {
    super();
  }

  get value(): number {
    return this.count; // }
  }

  handle = () => {
    /* } */
  };
}

interface Props {
  a: number;
}
"""

CSHARP = """\
using System;

namespace App.Core
{
    [Serializable]
    public class ToolExecutor : IExecutor
    {
        private readonly int _x = Compute(1);

        public ToolExecutor(int x) { _x = x; }

        /// <summary>Run it.</summary>
        public async Task<string> ExecuteAsync(string name, Dictionary<string, int> args)
        {
            var s = "{";
            return s;
        }

        public int Count => _x;
    }

    public enum Color { Red, Green }
}
"""

JAVA = """\
package app;

@Service
public class Budget {
    private int cap;

    @Override
    public boolean overBudget(int spent) {
        return spent > cap;
    }

    public <T> List<T> items(Map<String, T> m) {
        return null;
    }
}
"""

GO = """\
package main

import "fmt"

// Server serves.
type Server struct {
	port int
}

func (s *Server) Handle(w string) error {
	fmt.Println("}")
	return nil
}

func main() {
	s := `{
	`
	_ = s
}
"""

RUST = """\
use std::fmt;

#[derive(Debug)]
pub struct Wrapper<'a> {
    inner: &'a str,
}

impl<'a> fmt::Display for Wrapper<'a> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.inner)
    }
}

pub fn parse(c: char) -> bool {
    c == '{'
}
"""

CASES = [
    (
        "app/budget.py",
        PYTHON,
        [
            (1, 1, "", "code"),
            (3, 6, "over_budget", "function"),  # comment and decorator included
            (9, 11, "Ledger", "class"),  # the head: docstring, up to the first method
            (12, 13, "Ledger.add", "method"),
            (15, 16, "Ledger.flush", "method"),
            (18, 18, "Ledger", "code"),  # a statement after the methods
        ],
    ),
    (
        "web/store.ts",
        TYPESCRIPT,
        [
            (1, 1, "", "code"),
            (3, 6, "pageItems", "function"),  # "}{" in a string does not count
            (8, 10, "useThing", "function"),
            (12, 14, "Store", "class"),
            (15, 17, "Store.constructor", "method"),
            (19, 21, "Store.value", "method"),  # "}" in a comment does not count
            (23, 25, "Store.handle", "method"),
            (28, 30, "Props", "type"),
        ],
    ),
    (
        "src/ToolExecutor.cs",
        CSHARP,
        [
            (1, 3, "", "code"),  # usings and the namespace line, not its brace
            (5, 9, "ToolExecutor", "class"),  # attribute, declaration, a field
            (10, 10, "ToolExecutor.ToolExecutor", "method"),
            (12, 17, "ToolExecutor.ExecuteAsync", "method"),  # doc comment included
            (19, 19, "ToolExecutor", "code"),  # an expression-bodied property
            (22, 22, "Color", "type"),
        ],
    ),
    (
        "src/Budget.java",
        JAVA,
        [
            (1, 1, "", "code"),
            (3, 6, "Budget", "class"),
            (7, 10, "Budget.overBudget", "method"),  # annotation included
            (12, 14, "Budget.items", "method"),
        ],
    ),
    (
        "cmd/main.go",
        GO,
        [
            (1, 3, "", "code"),
            (5, 8, "Server", "type"),
            (10, 13, "Server.Handle", "method"),  # receiver type in the symbol
            (15, 19, "main", "function"),  # a brace in a raw string spanning lines
        ],
    ),
    (
        "src/lib.rs",
        RUST,
        [
            (1, 1, "", "code"),
            (3, 6, "Wrapper", "type"),  # attribute included; 'a is a lifetime
            (8, 8, "Wrapper", "type"),  # impl … for Wrapper
            (9, 11, "Wrapper.fmt", "method"),
            (14, 16, "parse", "function"),  # '{' is a character
        ],
    ),
]


def _rows(chunks: list[Chunk]) -> list[tuple[int, int, str, str]]:
    return [(c.start, c.end, c.symbol, c.kind) for c in chunks]


@pytest.mark.parametrize(
    ("path", "source", "expected"), CASES, ids=[c[0] for c in CASES]
)
def test_each_language_is_split_by_symbol(path, source, expected):
    assert _rows(chunk_file(path, source)) == expected


@pytest.mark.parametrize(
    ("path", "source", "_expected"), CASES, ids=[c[0] for c in CASES]
)
def test_every_line_that_holds_a_word_is_in_exactly_one_chunk(path, source, _expected):
    chunks = chunk_file(path, source)
    lines = source.splitlines()
    owners = [0] * (len(lines) + 1)
    for chunk in chunks:
        for n in range(chunk.start, chunk.end + 1):
            owners[n] += 1
    assert all(count <= 1 for count in owners), "a line in two chunks"
    for n, line in enumerate(lines, start=1):
        if re.search(r"\w", line):
            assert owners[n] == 1, (n, line)


def test_every_chunk_carries_its_path_and_symbol_for_the_index_and_the_reader():
    [_, chunk, *_] = chunk_file("app/budget.py", PYTHON)
    assert chunk.context == "app/budget.py over_budget"
    assert chunk.location == "app/budget.py:3-6 · over_budget (function)"
    [module, *_] = chunk_file("app/budget.py", PYTHON)
    assert module.location == "app/budget.py:1-1"


def test_python_that_does_not_parse_falls_back_to_windows():
    source = "def broken(:\n" + "".join(f"value_{n} = {n}\n" for n in range(100))
    chunks = chunk_file("broken.py", source)
    assert [c.kind for c in chunks] == ["window", "window"]
    assert (chunks[0].start, chunks[0].end) == (1, WINDOW_LINES)
    assert (chunks[1].start, chunks[1].end) == (WINDOW_LINES + 1, 101)


def test_an_unknown_language_is_cut_into_windows():
    source = "".join(f"line {n}\n" for n in range(1, 131))
    chunks = chunk_file("notes/readme.txt", source)
    assert _rows(chunks) == [
        (1, 60, "", "window"),
        (61, 120, "", "window"),
        (121, 130, "", "window"),
    ]


def test_a_symbol_longer_than_the_cap_is_cut_into_parts_that_keep_its_name():
    body = "".join(f"    total += {n}\n" for n in range(MAX_CHUNK_LINES + 30))
    chunks = chunk_file("long.py", f"def long_one():\n{body}")
    assert [c.symbol for c in chunks] == ["long_one", "long_one"]
    assert chunks[0].end - chunks[0].start + 1 == MAX_CHUNK_LINES
    assert chunks[1].start == chunks[0].end + 1
    assert chunks[1].end == MAX_CHUNK_LINES + 31


def test_closing_braces_alone_make_no_chunk():
    chunks = chunk_file("x.ts", "function f() {\n  return 1;\n}\n\n}\n};\n")
    assert _rows(chunks) == [(1, 3, "f", "function")]


def test_an_empty_or_blank_file_has_no_chunk():
    assert chunk_file("a.py", "") == []
    assert chunk_file("a.py", "\n   \n") == []


@pytest.mark.parametrize(
    ("path", "language"),
    [
        ("a.py", "python"),
        ("a/b.PYI", "python"),
        ("a.tsx", "typescript"),
        ("a.mjs", "javascript"),
        ("A.cs", "csharp"),
        ("A.java", "java"),
        ("a.go", "go"),
        ("a.rs", "rust"),
        ("a.kt", None),
        ("dir.py/readme", None),
        ("Makefile", None),
    ],
)
def test_language_of(path, language):
    assert language_of(path) == language

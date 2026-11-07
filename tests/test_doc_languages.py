"""doc_languages: declarations and doc comments in every supported language.

The Documentation tab and the drift detector used to read Python (AST) and a
few JS keywords only; a C#, Go or Rust project showed nothing (Leub's rule:
every feature works for every stack).
"""

from __future__ import annotations

import pytest
from doc_languages import doc_comment_template, extract_symbols, language_for
from doc_languages.polyglot import LANGUAGES, describe, doc_status


def _by_name(content: str, path: str) -> dict:
    return {s.name: s for s in extract_symbols(content, path)}


def _status(content: str, path: str, name: str) -> str:
    sym = _by_name(content, path)[name]
    lang = language_for(path)
    assert lang is not None
    return doc_status(sym, lang)


CSHARP = """namespace Acme.Orders;

/// <summary>Places orders.</summary>
public class OrderService
{
    /// <summary>Loads one order.</summary>
    /// <param name="id">Order id.</param>
    [HttpGet]
    public async Task<Order> GetOrderAsync(int id) { return null; }

    /// <summary>Cancels.</summary>
    public void Cancel(int id, string reason) { }

    private static string FormatName(
        string first,
        string last) { return ""; }

    public void Run() { if (x) { } }
}
"""


def test_csharp_methods_belong_to_their_class_with_allman_braces():
    symbols = _by_name(CSHARP, "src/OrderService.cs")
    assert set(symbols) == {
        "OrderService",
        "OrderService.GetOrderAsync",
        "OrderService.Cancel",
        "OrderService.FormatName",
        "OrderService.Run",
    }
    assert symbols["OrderService.FormatName"].args == ["first", "last"]
    assert symbols["OrderService.GetOrderAsync"].returns is True
    assert symbols["OrderService.Cancel"].returns is False


def test_csharp_doc_status_reads_xml_doc_above_attributes():
    path = "src/OrderService.cs"
    assert _status(CSHARP, path, "OrderService.GetOrderAsync") == "documented"
    assert _status(CSHARP, path, "OrderService.Cancel") == "partial"
    assert _status(CSHARP, path, "OrderService.FormatName") == "missing"


def test_csharp_template_is_xml_doc_indented_like_the_method():
    sym = _by_name(CSHARP, "a.cs")["OrderService.FormatName"]
    draft = doc_comment_template(sym)
    assert draft.splitlines()[0] == "    /// <summary>"
    assert '/// <param name="first"></param>' in draft
    assert "/// <returns></returns>" in draft


@pytest.mark.parametrize(
    ("path", "content", "expected"),
    [
        (
            "billing/invoice.go",
            "// Invoice is a bill.\ntype Invoice struct{}\n\n"
            "// Issue sends it.\nfunc (i *Invoice) Issue(email string) error { return nil }\n"
            "func Refund(id string, amount int) error { return nil }\n",
            {
                "Invoice": "documented",
                "Invoice.Issue": "documented",
                "Refund": "missing",
            },
        ),
        (
            "src/thing.rs",
            "/// A thing.\n#[derive(Debug)]\npub struct Thing {}\nimpl Thing {\n"
            "    pub fn new(name: &str) -> Self { }\n    fn tick(&mut self) {}\n}\n",
            {"Thing": "documented", "Thing.new": "missing", "Thing.tick": "missing"},
        ),
        (
            "App.kt",
            "/** A user. */\ndata class User(val name: String)\n"
            'fun greet(name: String, times: Int = 1): String = ""\n',
            {"User": "documented", "greet": "missing"},
        ),
        (
            "Store.swift",
            "/// Store.\nstruct Store {\n  /// Loads.\n  /// - Parameter id: the id\n"
            "  func load(_ id: Int) -> Data { }\n}\n",
            {"Store": "documented", "Store.load": "documented"},
        ),
        (
            "Repo.php",
            "<?php\nclass Repo {\n  /** Find. */\n  public function find(int $id): ?User {}\n}\n",
            {"Repo": "missing", "Repo.find": "partial"},
        ),
        (
            "util.rb",
            "# Utility.\nclass Util\n  # Computes.\n  def compute(a, b = 2)\n  end\nend\n",
            {"Util": "documented", "Util.compute": "documented"},
        ),
        (
            "lib/widget.dart",
            "/// A widget.\nclass Widget {\n  Future<void> build(BuildContext context) async {\n  }\n}\n",
            {"Widget": "documented", "Widget.build": "missing"},
        ),
        (
            "Main.java",
            "public class Main {\n  /** Sum.\n   * @param a a\n   * @param b b\n   */\n"
            "  public static int sum(final int a, @NonNull Integer b) { return a; }\n}\n",
            {"Main": "missing", "Main.sum": "documented"},
        ),
        (
            "web/cart.ts",
            "/** A cart line. */\nexport interface CartLine { sku: string }\n"
            "export function addToCart(sku: string, qty = 1): CartLine[] { return []; }\n"
            "export const total = async (lines: CartLine[]) => 0;\n",
            {"CartLine": "documented", "addToCart": "missing", "total": "missing"},
        ),
        (
            "math.cpp",
            "/** @brief Adds. @param a a @param b b */\nint add(int a, int b) {\n  return a + b;\n}\n",
            {"add": "documented"},
        ),
    ],
)
def test_each_language_reads_declarations_and_doc_comments(path, content, expected):
    symbols = _by_name(content, path)
    lang = language_for(path)
    assert lang is not None
    assert {name: doc_status(symbols[name], lang) for name in expected} == expected


def test_statements_are_not_declarations():
    js = "class A {\n  run() {\n    if (x) {\n    }\n    for (const y of z) {\n    }\n  }\n}\n"
    assert set(_by_name(js, "a.ts")) == {"A", "A.run"}


def test_every_language_has_a_template_style_and_extensions():
    seen: set[str] = set()
    for lang in LANGUAGES:
        assert lang.extensions
        assert not seen & set(lang.extensions), (
            f"{lang.id}: an extension is listed twice"
        )
        seen |= set(lang.extensions)
    assert language_for("README.md") is None
    assert language_for("Program.CS").id == "csharp"


@pytest.mark.parametrize(
    ("path", "content", "first_line"),
    [
        ("a.go", "func Refund(id string) error { return nil }\n", "// Refund"),
        ("a.rs", "fn tick(n: u32) -> u32 { n }\n", "/// Tick."),
        ("a.swift", "func load(_ id: Int) -> Data { }\n", "/// Load."),
        ("a.rb", "def compute(a)\nend\n", "# Compute."),
        ("a.kt", 'fun greet(name: String): String = ""\n', "/**"),
        ("a.cpp", "int add(int a, int b) {\n}\n", "/**"),
    ],
)
def test_templates_follow_each_language_convention(path, content, first_line):
    sym = extract_symbols(content, path)[0]
    assert doc_comment_template(sym).splitlines()[0].startswith(first_line)


def test_describe_splits_names_and_drops_async():
    assert describe("OrderService.GetOrderAsync") == "Get order."
    assert describe("vat_rate") == "Vat rate."
    assert describe("x") == "X."

"""Code examples in the docs, checked against the project without running them (#354).

Python examples must parse, import what the project still has and call its
functions with arguments they accept; JSON must parse; every other stack's
import of the project's own code must name what the project still has. An
excerpt, a placeholder, another project's module and a ``no-drift-check``
mark are never reported.
"""

from __future__ import annotations

from pathlib import Path

from doc_drift_detector.examples import (
    OwnCode,
    check_examples,
    code_blocks,
    ignored_lines,
    own_code_from_manifests,
    python_index,
)

SHOP = {
    "src/shop/__init__.py": "",
    "src/shop/cart.py": (
        "from .money import Money\n\n"
        "def add(cart, item, qty=1, *, note=None):\n    pass\n\n"
        "def total(cart):\n    pass\n\n"
        "class Cart:\n    pass\n"
    ),
    "src/shop/money.py": "class Money:\n    pass\n",
}


def _own(files: dict[str, str], **extra) -> OwnCode:
    modules, packages = python_index(set(files))
    words = {w for text in files.values() for w in text.replace("(", " ").split()}
    return OwnCode(
        python_modules=modules,
        python_packages=packages,
        code_words=words,
        files=set(files),
        read=files.get,
        **extra,
    )


def _kinds(markdown: str, own: OwnCode) -> list[tuple[str, str]]:
    return [(i.kind, i.symbol) for i in check_examples(markdown, own)]


def _py(code: str) -> str:
    return f"# Shop\n\n```python\n{code}\n```\n"


def test_python_imports_and_calls_are_checked_against_the_project():
    own = _own(SHOP)
    assert (
        _kinds(_py("from shop.cart import add, Cart\nadd(c, item, 2, note='x')"), own)
        == []
    )
    assert _kinds(_py("from shop.basket import add"), own) == [
        ("unknown_module", "shop.basket")
    ]
    assert _kinds(_py("from shop.cart import remove"), own) == [
        ("unknown_name", "shop.cart.remove")
    ]
    assert _kinds(_py("from shop.cart import add\nadd(c, i, 1, 2)"), own) == [
        ("wrong_arguments", "shop.cart.add")
    ]
    assert _kinds(_py("from shop.cart import add\nadd(c, i, colour='red')"), own) == [
        ("wrong_arguments", "shop.cart.add")
    ]
    assert _kinds(_py("from shop.cart import total\ntotal()"), own) == [
        ("wrong_arguments", "shop.cart.total")
    ]
    # re-exported names and submodules count as defined
    assert _kinds(_py("from shop.cart import Money\nfrom shop import cart"), own) == []


def test_other_projects_unpacking_and_placeholders_are_not_reported():
    own = _own(SHOP)
    assert _kinds(_py("from requests import nothing_here\nimport os.nope"), own) == []
    assert _kinds(_py("from shop.cart import add\nadd(*args, **kw)"), own) == []
    assert _kinds(_py("client = Client(api_key=<your-key>)"), own) == []


def test_python_syntax_doctest_and_indented_blocks():
    own = _own(SHOP)
    assert _kinds(_py("def broken(:\n    pass"), own)[0][0] == "syntax"
    assert _kinds(_py(">>> from shop.cart import add\n>>> add(1, 2)\nNone"), own) == []
    in_a_list = "1. Try it:\n\n   ```python\n   # a comment\n   from shop.cart import add\n   ```\n"
    assert _kinds(in_a_list, own) == []


def test_json_blocks_must_parse_unless_they_are_excerpts():
    own = _own({})
    broken = '```json\n{\n  "a": 1,\n}\n```\n'
    issues = check_examples(broken, own)
    assert [i.kind for i in issues] == ["invalid_json"]
    assert issues[0].line == 4
    for fine in [
        '{"a": 1}',
        '{\n  // jsonc\n  "a": 1\n}',
        '"key": {"a": 1}',
        '{"a": 1}\n{"b": 2}',
        '{"a": ...}',
    ]:
        assert check_examples(f"```json\n{fine}\n```\n", own) == [], fine


def test_no_drift_check_skips_the_next_block_or_the_whole_file():
    own = _own(SHOP)
    marked = "Intro.\n\n<!-- no-drift-check -->\n```python\nfrom shop.basket import x\n```\n\n```python\nfrom shop.gone import y\n```\n"
    assert _kinds(marked, own) == [("unknown_module", "shop.gone")]
    assert ignored_lines("<!-- no-drift-check -->\n# Future API\n") is None
    assert (
        _kinds("<!-- no-drift-check -->\n" + _py("from shop.gone import y"), own) == []
    )


def test_every_stack_s_own_imports(tmp_path: Path):
    files = {
        "web/package.json": '{"name": "@acme/web"}',
        "web/src/index.ts": "export function createClient() {}\n",
        "go.mod": "module github.com/acme/shop\n",
        "internal/cart/cart.go": "package cart\n",
        "Cargo.toml": '[package]\nname = "acme-shop"\nversion = "0.1.0"\n',
        "src/lib.rs": "pub struct Cart;\n",
        "app/pubspec.yaml": "name: acme_app\n",
        "app/lib/cart.dart": "class Cart {}\n",
        "composer.json": '{"autoload": {"psr-4": {"Acme\\\\": "src/"}}}',
        "src/Cart.php": "<?php namespace Acme; class Cart {}\n",
        "acme.gemspec": "",
        "lib/acme/cart.rb": "class Cart; end\n",
    }
    for rel, text in files.items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text, encoding="utf-8")
    own = _own(
        files,
        namespaces={"Acme.Shop", "Acme.Shop.Cart", "com.acme.shop"},
        **own_code_from_manifests(tmp_path, set(files)),
    )

    def kinds(lang: str, code: str):
        return _kinds(f"```{lang}\n{code}\n```\n", own)

    assert kinds("ts", 'import { createClient } from "@acme/web";') == []
    assert kinds("ts", 'import { makeClient } from "@acme/web";') == [
        ("unknown_name", "@acme/web:makeClient")
    ]
    assert kinds("ts", 'import { anything } from "react";') == []
    assert kinds("go", 'import "github.com/acme/shop/internal/cart"') == []
    assert kinds("go", 'import "github.com/acme/shop/internal/basket"') == [
        ("unknown_module", "github.com/acme/shop/internal/basket")
    ]
    assert kinds("rust", "use acme_shop::Cart;") == []
    assert kinds("rust", "use acme_shop::{Cart, Basket};") == [
        ("unknown_name", "acme_shop::Basket")
    ]
    assert kinds("dart", "import 'package:acme_app/cart.dart';") == []
    assert kinds("dart", "import 'package:acme_app/basket.dart';") == [
        ("unknown_module", "package:acme_app/basket.dart")
    ]
    assert kinds("php", "use Acme\\Basket;") == [("unknown_name", "Acme\\Basket")]
    assert kinds("csharp", "using Acme.Shop.Cart;") == []
    assert kinds("csharp", "using Acme.Billing;") == [
        ("unknown_module", "Acme.Billing")
    ]
    assert kinds("csharp", "using Microsoft.Extensions.Logging;") == []
    assert kinds("java", "import com.acme.shop.Basket;") == [
        ("unknown_name", "com.acme.shop.Basket")
    ]
    assert kinds("ruby", 'require "acme/cart"') == []
    assert kinds("ruby", 'require "acme/basket"') == [("unknown_module", "acme/basket")]


def test_code_blocks_keep_their_language_and_first_line():
    blocks = code_blocks("a\n\n~~~ts\nconst x = 1\n~~~\n\n```{python}\nx = 1\n```\n")
    assert [(b.lang, b.line, b.code) for b in blocks] == [
        ("ts", 4, "const x = 1"),
        ("python", 8, "x = 1"),
    ]

"""Doc comments against their declarations, on every stack (#354).

A documented parameter the code no longer has is reported, a rename in place
is reported as a rename (and can be fixed), a parameter the comment leaves out
is reported low; type parameters, destructured or rest parameters, ``**kwargs``
and comments without parameter tags are never guessed at.
"""

from __future__ import annotations

import pytest
from doc_drift_detector.signatures import (
    documented_params,
    rename_in_doc,
    retype_in_doc,
    signature_drifts,
)


def _one(path: str, code: str):
    drifts = signature_drifts(path, code)
    assert len(drifts) == 1, drifts
    return drifts[0]


TS_RENAMED = """
/**
 * Waits for the checks.
 *
 * @param token GitHub token
 * @param sendProgress progress callback
 * @param signal abort signal
 */
export async function wait(
\ttoken: string,
\t// a comment (with, commas)
\tsendProgress: (progress: Progress) => void,
\tabortSignal?: AbortSignal,
): Promise<void> {}
"""


def test_a_typescript_rename_is_read_through_nested_parentheses_and_comments():
    drift = _one("src/ci.ts", TS_RENAMED)
    assert drift.renamed == [("signal", "abortSignal")]
    assert drift.removed == [] and drift.added == []
    assert drift.severity == "high"


def test_a_jsdoc_that_matches_is_silent():
    code = "/**\n * @param {string} a first\n * @param {number} [b=2] second\n */\nfunction f(a, b = 2) {}\n"
    assert signature_drifts("x.js", code) == []


@pytest.mark.parametrize(
    ("path", "code", "removed", "added"),
    [
        (
            "Cart.cs",
            '/// <summary>Adds.</summary>\n/// <param name="item">x</param>\n/// <param name="qty">y</param>\npublic void Add(Item item) {}\n',
            ["qty"],
            [],
        ),
        (
            "Cart.java",
            "/**\n * @param <T> the type\n * @param item x\n * @param qty y\n */\npublic <T> void add(T item) {}\n",
            ["qty"],
            [],
        ),
        (
            "Cart.kt",
            "/**\n * @param T the type\n * @param item x\n */\nfun <T> add(item: T, qty: Int) {}\n",
            [],
            ["qty"],
        ),
        (
            "Cart.php",
            "/**\n * @param Item $item x\n * @param int $qty y\n */\npublic function add(Item $item) {}\n",
            ["qty"],
            [],
        ),
        (
            "Cart.swift",
            "/// Adds.\n/// - Parameters:\n///   - item: x\n///   - qty: y\nfunc add(item: Item) {}\n",
            ["qty"],
            [],
        ),
        (
            "cart.rs",
            "/// Adds.\n///\n/// # Arguments\n///\n/// * `item` - x\n/// * `qty` - y\npub fn add<'a>(item: &'a Item) {}\n",
            ["qty"],
            [],
        ),
        (
            "cart.rb",
            "# Adds.\n# @param item [Item] x\n# @param qty [Integer] y\ndef add(item)\nend\n",
            ["qty"],
            [],
        ),
        (
            "cart.cpp",
            "/**\n * @brief Adds.\n * @param[in] item x\n * @param qty y\n */\nvoid add(const Item& item) {\n}\n",
            ["qty"],
            [],
        ),
    ],
)
def test_every_stack_names_a_parameter_the_code_no_longer_takes(
    path, code, removed, added
):
    drift = _one(path, code)
    assert drift.removed == removed
    assert drift.added == added


def test_comments_without_tags_and_unreadable_signatures_are_not_compared():
    go = "// Add adds item to the cart.\nfunc Add(item Item, qty int) {}\n"
    destructured = "/**\n * @param options the options\n */\nfunction f({ a, b }) {}\n"
    rest = (
        "/**\n * @param first x\n * @param rest y\n */\nfunction f(first, ...more) {}\n"
    )
    marked = "/**\n * no-drift-check: documents the next version\n * @param future x\n */\nfunction f(now) {}\n"
    for path, code in [
        ("a.go", go),
        ("a.js", destructured),
        ("b.js", rest),
        ("c.js", marked),
    ]:
        assert signature_drifts(path, code) == [], path


GOOGLE = '''
def charge(amount: float, currency: str, *, retries: int = 3) -> None:
    """Charge a card.

    Args:
        amount (int): what to charge.
        money (str): the currency.
            Continued: like this.
        retries: how many times.

    Returns:
        Nothing.
    """
'''


def test_a_python_google_docstring_rename_and_type_change():
    drift = _one("pay.py", GOOGLE)
    assert drift.renamed == [("money", "currency")]
    assert drift.types == [("amount", "int", "float")]


def test_numpy_and_sphinx_docstrings_and_kwargs():
    numpy = '''
class Cart:
    def add(self, item, qty):
        """Add.

        Parameters
        ----------
        item : Item
            The item.
        count : int
            How many.
        """
'''
    drift = _one("cart.py", numpy)
    assert drift.symbol == "Cart.add"
    assert drift.renamed == [("count", "qty")]

    sphinx = 'def f(a, **kwargs):\n    """Do.\n\n    :param a: first\n    :param timeout: passed on\n    """\n'
    assert signature_drifts("f.py", sphinx) == []  # timeout may go through **kwargs


def test_documented_params_reads_types_where_the_style_has_them():
    names, types = documented_params(
        " * @param {string} name x\n * @param {Opts} options.timeout y", "jsdoc"
    )
    assert names == ["name"] and types == {"name": "string"}


def test_rename_and_retype_fix_only_the_doc_comment():
    fixed = rename_in_doc(
        TS_RENAMED,
        TS_RENAMED.splitlines().index("export async function wait(") + 1,
        "typescript",
        "signal",
        "abortSignal",
    )
    assert fixed is not None
    assert "@param abortSignal abort signal" in fixed
    assert signature_drifts("src/ci.ts", fixed) == []

    line = (
        GOOGLE.splitlines().index(
            "def charge(amount: float, currency: str, *, retries: int = 3) -> None:"
        )
        + 1
    )
    renamed = rename_in_doc(GOOGLE, line, "python", "money", "currency")
    retyped = retype_in_doc(renamed or "", line, "amount", "int", "float")
    assert retyped is not None
    assert "currency (str): the currency." in retyped
    assert "amount (float): what to charge." in retyped
    assert signature_drifts("pay.py", retyped) == []

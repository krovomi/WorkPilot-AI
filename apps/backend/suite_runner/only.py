"""Run only some tests: each stack's own filter (#351).

A suite too long to run five times can still confirm its suspects: the run
keeps only the tests named, with the flag of its stack (``pytest -k``,
``vitest -t``, ``dotnet test --filter``, ``go test -run``, ``mvn -Dtest``,
``gradle --tests``, ``cargo test -- <name>``, ``phpunit --filter``,
``rspec -e``, ``dart test --name``, ``swift test --filter``,
``node --test-name-pattern``). The names come from test reports, so they are reduced to
the characters a test name uses, and every special character of the filter
syntax is escaped: the filter selects tests, it never adds an option.
"""

from __future__ import annotations

import re

from .names import parse_test_name

__all__ = ["MAX_NAMES", "dotnet_filters", "filter_args"]

MAX_NAMES = 50
_SAFE = re.compile(r"[^\w.$#:/ <>\-,'\[\]()]")
_JS_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\/]")
_RUST_PATH = re.compile(r"[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*")
_DOTNET_SPECIAL = re.compile(r"([\\()&|=!~])")


def _clean(name: str) -> str:
    return _SAFE.sub("", name).strip()[:300]


def _identifier(value: str) -> str:
    return re.sub(r"\W", "", value)


def _parsed(names: list[str]) -> list[tuple[str, str]]:
    parsed = [
        parse_test_name(_clean(n))
        for n in names[:MAX_NAMES]
        if isinstance(n, str) and _clean(n)
    ]
    return [(container, leaf) for container, leaf in parsed if leaf]


def _vstest_filter(parsed: list[tuple[str, str]]) -> list[str]:
    terms = []
    for container, leaf in parsed:
        full = f"{container}.{leaf}" if container and "/" not in container else leaf
        terms.append("FullyQualifiedName~" + _DOTNET_SPECIAL.sub(r"\\\1", full))
    return ["--filter", "|".join(sorted(set(terms)))]


def _js_regex(parsed: list[tuple[str, str]]) -> str:
    return "|".join(
        sorted(
            {_JS_SPECIAL.sub(lambda m: "\\" + m.group(0), leaf) for _, leaf in parsed}
        )
    )


def dotnet_filters(names: list[str]) -> dict[str, list[str]]:
    """``dotnet test``'s filters: VSTest syntax, and xunit.v3's own under
    Microsoft.Testing.Platform (``--filter-method``, ``*`` at either end)."""
    parsed = _parsed(names)
    if not parsed:
        return {}
    methods: list[str] = []
    for container, leaf in parsed:
        method = _identifier(leaf)
        if not method:
            continue
        owner = container if container and "/" not in container else ""
        methods += ["--filter-method", f"{owner}.{method}" if owner else f"*.{method}"]
    return {"vstest": _vstest_filter(parsed), "xunit_v3": methods}


def filter_args(command_id: str, names: list[str]) -> list[str]:
    """The arguments that keep only ``names``; empty when the stack has no filter or no name is usable."""
    parsed = _parsed(names)
    if not parsed:
        return []
    if command_id == "pytest":
        leaves = sorted({_identifier(leaf) for _, leaf in parsed} - {""})
        return ["-k", " or ".join(leaves)] if leaves else []
    if command_id in {"vitest", "jest"}:
        return ["-t", _js_regex(parsed)]
    if command_id == "node":
        return [f"--test-name-pattern={_js_regex(parsed)}"]
    # One "--option=value" token: a value that starts with "-" stays a value.
    if command_id in {"dart", "flutter"}:
        return [f"--name={_js_regex(parsed)}"]
    if command_id in {"phpunit", "pest", "swift"}:
        return [f"--filter={_js_regex(parsed)}"]
    if command_id == "rspec":
        return [f"--example={leaf}" for leaf in sorted({leaf for _, leaf in parsed})]
    if command_id == "cargo":
        # libtest takes several name filters after "--"; a Rust test path
        # only, so a name never reads as one of libtest's options.
        paths = sorted({leaf for _, leaf in parsed if _RUST_PATH.fullmatch(leaf)})
        return ["--", *paths] if paths else []
    if command_id == "dotnet":
        return _vstest_filter(parsed)
    if command_id == "go":
        leaves = sorted({_identifier(leaf.split("/")[0]) for _, leaf in parsed} - {""})
        return ["-run", f"^({'|'.join(leaves)})$"] if leaves else []
    if command_id == "maven":
        tests = sorted(
            {
                f"{_identifier(container.split('.')[-1])}#{_identifier(leaf)}"
                for container, leaf in parsed
                if _identifier(container.split(".")[-1]) and _identifier(leaf)
            }
        )
        return (
            [f"-Dtest={','.join(tests)}", "-Dsurefire.failIfNoSpecifiedTests=false"]
            if tests
            else []
        )
    if command_id == "gradle":
        args = []
        for container, leaf in parsed:
            classname = ".".join(
                _identifier(p) for p in container.split(".") if _identifier(p)
            )
            if classname and _identifier(leaf):
                args += ["--tests", f"{classname}.{_identifier(leaf)}"]
        return args
    return []

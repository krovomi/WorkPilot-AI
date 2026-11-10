"""Run only some tests: each stack's own filter (#351).

A suite too long to run five times can still confirm its suspects: the run
keeps only the tests named, with the flag of its stack (``pytest -k``,
``vitest -t``, ``dotnet test --filter``, ``go test -run``, ``mvn -Dtest``,
``gradle --tests``). The names come from test reports, so they are reduced to
the characters a test name uses, and every special character of the filter
syntax is escaped: the filter selects tests, it never adds an option.
"""

from __future__ import annotations

import re

from .names import parse_test_name

__all__ = ["MAX_NAMES", "filter_args"]

MAX_NAMES = 50
_SAFE = re.compile(r"[^\w.$#:/ <>\-,'\[\]()]")
_JS_SPECIAL = re.compile(r"[.*+?^${}()|[\]\\/]")
_DOTNET_SPECIAL = re.compile(r"([\\()&|=!~])")


def _clean(name: str) -> str:
    return _SAFE.sub("", name).strip()[:300]


def _identifier(value: str) -> str:
    return re.sub(r"\W", "", value)


def filter_args(command_id: str, names: list[str]) -> list[str]:
    """The arguments that keep only ``names``; empty when the stack has no filter or no name is usable."""
    parsed = [
        parse_test_name(_clean(n))
        for n in names[:MAX_NAMES]
        if isinstance(n, str) and _clean(n)
    ]
    parsed = [(container, leaf) for container, leaf in parsed if leaf]
    if not parsed:
        return []
    if command_id == "pytest":
        leaves = sorted({_identifier(leaf) for _, leaf in parsed} - {""})
        return ["-k", " or ".join(leaves)] if leaves else []
    if command_id in {"vitest", "jest"}:
        titles = sorted(
            {_JS_SPECIAL.sub(lambda m: "\\" + m.group(0), leaf) for _, leaf in parsed}
        )
        return ["-t", "|".join(titles)]
    if command_id == "dotnet":
        terms = []
        for container, leaf in parsed:
            full = f"{container}.{leaf}" if container and "/" not in container else leaf
            terms.append("FullyQualifiedName~" + _DOTNET_SPECIAL.sub(r"\\\1", full))
        return ["--filter", "|".join(sorted(set(terms)))]
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
        args: list[str] = []
        for container, leaf in parsed:
            classname = ".".join(
                _identifier(p) for p in container.split(".") if _identifier(p)
            )
            if classname and _identifier(leaf):
                args += ["--tests", f"{classname}.{_identifier(leaf)}"]
        return args
    return []

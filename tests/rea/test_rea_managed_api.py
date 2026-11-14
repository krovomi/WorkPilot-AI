"""The public API of two builds of a .NET assembly, compared by REA (lot D).

The fixtures follow the shapes REA 6.9.0 printed for real assemblies
(``inspect-managed-members`` and ``compare-managed-members``): tokens are
build-local, visibility comes from the ECMA-335 flags, and a partial read or an
unpaired public member is unknown, never compatible.
"""

from __future__ import annotations

import copy
from pathlib import Path

from rea import ReaLauncher, ReaRun, ReaUnavailable
from rea.managed_api import (
    BREAKING,
    COMPATIBLE,
    UNKNOWN,
    public_api_diff,
    visible_members,
)

LAUNCHER = ReaLauncher(
    argv=("node", "rea.mjs"),
    source="installed",
    node_version="22.23.4",
    version="6.9.0",
)
PUBLIC, INTERNAL, PRIVATE = 6, 3, 1
TYPE = "0x02000002"


def inspection(*methods: tuple[str, str, int], type_flags: int = 1, **extra) -> dict:
    data = {
        "coverage": {"state": "complete"},
        "metadata": {"status": "complete"},
        "selection": None,
        "types": [
            {
                "token": TYPE,
                "full_name": "Lib.Api",
                "flags": type_flags,
                "enclosing_type_token": None,
            }
        ],
        "methods": [
            {
                "token": token,
                "declaring_type_token": TYPE,
                "declaring_type": "Lib.Api",
                "name": name,
                "flags": flags,
            }
            for token, name, flags in methods
        ],
        "fields": [],
    }
    data.update(extra)
    return data


def ident(
    token: str, name: str, signature: str = "s1", parent: str = "Lib.Api"
) -> dict:
    return {
        "token": token,
        "declaring_type": parent,
        "name": name,
        "signature_sha256": signature,
    }


def item(
    status: str, left: dict | None, right: dict | None, pairing: str = "", **match
) -> dict:
    pairing = pairing or ("matched" if left and right else "unmatched")
    return {
        "status": status,
        "left": left,
        "right": right,
        "match": {"status": pairing, **match},
    }


def comparison(*methods: dict, coverage: str = "complete-within-inputs") -> dict:
    return {"coverage": {"status": coverage}, "methods": list(methods), "fields": []}


def diff(before: dict, after: dict, compared: dict, tmp_path: Path, **kwargs):
    left, right = tmp_path / "a" / "Lib.dll", tmp_path / "b" / "Lib.dll"
    calls: list[tuple[str, list[Path]]] = []

    def runner(command, paths, **_):
        calls.append((command, list(paths)))
        if command == "compare-managed-members":
            return ReaRun(ok=True, exit_code=0, result=compared)
        return ReaRun(
            ok=True, exit_code=0, result=before if paths[0] == left else after
        )

    result = public_api_diff(
        left, right, launcher=kwargs.pop("launcher", LAUNCHER), runner=runner, **kwargs
    )
    return result, calls


def test_an_unchanged_public_api_is_compatible(tmp_path):
    side = inspection(("0x06000001", "Run", PUBLIC))
    result, calls = diff(
        side,
        side,
        comparison(
            item("unchanged", ident("0x06000001", "Run"), ident("0x06000001", "Run"))
        ),
        tmp_path,
    )
    assert result.status == COMPATIBLE
    assert result.public_members == 1 and not result.breaking
    assert [c for c, _ in calls] == [
        "inspect-managed-members",
        "inspect-managed-members",
        "compare-managed-members",
    ]


def test_a_removed_public_member_breaks(tmp_path):
    result, _ = diff(
        inspection(("0x06000001", "Run", PUBLIC)),
        inspection(),
        comparison(item("removed", ident("0x06000001", "Run"), None)),
        tmp_path,
    )
    assert result.status == BREAKING
    assert [(c.kind, c.member) for c in result.breaking] == [("removed", "Lib.Api.Run")]


def test_a_member_made_internal_is_hidden(tmp_path):
    result, _ = diff(
        inspection(("0x06000001", "Run", PUBLIC)),
        inspection(("0x06000001", "Run", INTERNAL)),
        comparison(
            item("changed", ident("0x06000001", "Run"), ident("0x06000001", "Run"))
        ),
        tmp_path,
    )
    assert [c.kind for c in result.breaking] == ["hidden"]


def test_a_changed_signature_and_a_rename_break(tmp_path):
    side = inspection(("0x06000001", "Run", PUBLIC), ("0x06000002", "Stop", PUBLIC))
    after = inspection(("0x06000001", "Run", PUBLIC), ("0x06000002", "Halt", PUBLIC))
    result, _ = diff(
        side,
        after,
        comparison(
            item(
                "changed", ident("0x06000001", "Run"), ident("0x06000001", "Run", "s2")
            ),
            item("changed", ident("0x06000002", "Stop"), ident("0x06000002", "Halt")),
        ),
        tmp_path,
    )
    kinds = {(c.kind, c.member, c.detail) for c in result.breaking}
    assert kinds == {
        ("signature", "Lib.Api.Run", ""),
        ("renamed", "Lib.Api.Stop", "Lib.Api.Halt"),
    }


def test_non_public_changes_and_additions_do_not_break(tmp_path):
    result, _ = diff(
        inspection(("0x06000001", "Run", PUBLIC), ("0x06000002", "Helper", PRIVATE)),
        inspection(("0x06000001", "Run", PUBLIC), ("0x06000003", "Start", PUBLIC)),
        comparison(
            item("changed", ident("0x06000001", "Run"), ident("0x06000001", "Run")),
            item("removed", ident("0x06000002", "Helper"), None),
            item("added", None, ident("0x06000003", "Start")),
        ),
        tmp_path,
    )
    assert result.status == COMPATIBLE
    assert [c.member for c in result.added] == ["Lib.Api.Start"]


def test_a_member_of_an_internal_type_is_not_public(tmp_path):
    result, _ = diff(
        inspection(("0x06000001", "Run", PUBLIC), type_flags=0),
        inspection(type_flags=0),
        comparison(item("removed", ident("0x06000001", "Run"), None)),
        tmp_path,
    )
    assert result.status == COMPATIBLE and result.public_members == 0


def test_a_nested_type_is_visible_only_through_its_enclosing_chain():
    data = inspection(("0x06000001", "Run", PUBLIC), type_flags=2)
    assert visible_members(data) == set()  # nested, its enclosing type unread
    data["types"][0]["enclosing_type_token"] = "0x02000001"
    data["types"].append(
        {
            "token": "0x02000001",
            "full_name": "Lib.Outer",
            "flags": 1,
            "enclosing_type_token": None,
        }
    )
    assert visible_members(data) == {"methods:0x06000001"}
    data["types"][1]["flags"] = 0  # the outer type is internal
    assert visible_members(data) == set()


def test_a_partial_read_is_unknown_never_compatible(tmp_path):
    partial = inspection(coverage={"state": "partial"})
    result, _ = diff(
        inspection(("0x06000001", "Run", PUBLIC)), partial, comparison(), tmp_path
    )
    assert result.status == UNKNOWN and "only in part" in result.unknown
    selected = inspection(selection={"types": ["Lib.Api"]})
    result, _ = diff(selected, selected, comparison(), tmp_path)
    assert result.status == UNKNOWN and "selection" in result.unknown
    side = inspection(("0x06000001", "Run", PUBLIC))
    result, _ = diff(side, side, comparison(coverage="partial"), tmp_path)
    assert result.status == UNKNOWN and "partial" in result.unknown


def test_an_ambiguous_public_member_is_unknown(tmp_path):
    side = inspection(("0x06000001", "Run", PUBLIC), ("0x06000002", "Run", PUBLIC))
    ambiguous = item(
        "unknown", None, None, "ambiguous", candidate_left_tokens=["0x06000001"]
    )
    result, _ = diff(side, side, comparison(ambiguous), tmp_path)
    assert result.status == UNKNOWN and "unambiguously" in result.unknown
    assert not result.breaking and not result.added
    private = inspection(("0x06000001", "Run", PRIVATE))
    result, _ = diff(private, private, comparison(ambiguous), tmp_path)
    assert result.status == COMPATIBLE


def test_an_undecided_public_member_is_unknown(tmp_path):
    side = inspection(("0x06000001", "Run", PUBLIC))
    result, _ = diff(
        side,
        side,
        comparison(
            item("unknown", ident("0x06000001", "Run"), ident("0x06000001", "Run"))
        ),
        tmp_path,
    )
    assert result.status == UNKNOWN


def test_unreadable_tables_are_unknown(tmp_path):
    broken = copy.deepcopy(inspection(("0x06000001", "Run", PUBLIC)))
    broken["methods"][0]["flags"] = "public"
    result, _ = diff(broken, broken, comparison(), tmp_path)
    assert result.status == UNKNOWN and "unreadable" in result.unknown


def test_no_rea_or_no_answer_is_unknown(tmp_path):
    result, calls = diff(
        {},
        {},
        comparison(),
        tmp_path,
        launcher=ReaUnavailable("node_missing", "Node.js is not on PATH"),
    )
    assert result.status == UNKNOWN and "node_missing" in result.unknown and not calls

    def silent(command, paths, **_):
        return ReaRun(ok=False, error="timeout", detail="600 s")

    result = public_api_diff(
        tmp_path / "a.dll", tmp_path / "b.dll", launcher=LAUNCHER, runner=silent
    )
    assert result.status == UNKNOWN and "timeout" in result.unknown

"""The whole scan, git staleness, the fixes, the QA gate and the CLI (#354).

A document is stale when the code it describes was committed after it; its
freshness score falls with its problems and its age. The simple fixes are made
only where the drift still is, inside the project. The QA gate reads a task's
own changes and only blocks in ``strict``; the CLI warns and exits 0 unless
``--strict``, and exits 2 when it cannot compare.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import pytest
from doc_drift_detector.__main__ import main as cli
from doc_drift_detector.autosync import apply_fixes, parse_fix_id
from doc_drift_detector.project import scan_project
from doc_drift_detector.staleness import freshness_score
from foundation.change_scope import ChangeScope
from qa.doc_drift_gate import DOC_DRIFT_ENV, RECORD, doc_drift_gate

DAY = 86_400
# git reads two years of history: the commits must be recent.
START = int(time.time()) - 200 * DAY


def _env(when: int | None = None) -> dict[str, str]:
    # A git hook exports GIT_* variables (index, author): the test's repo ignores them.
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.test",
        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.test",
    )  # fmt: skip
    if when is not None:
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = f"@{when} +0000"
    return env


def _git(root: Path, *args: str, when: int | None = None) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        env=_env(when),
    ).stdout.strip()


def _write(root: Path, rel: str, text: str) -> None:
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(text, encoding="utf-8")


CART_TS = """/**
 * Adds an item.
 * @param cart the cart
 * @param qty how many
 */
export function addItem(cart: Cart, quantity: number) {}
"""


@pytest.fixture(autouse=True)
def _default_mode(monkeypatch):
    monkeypatch.delenv(DOC_DRIFT_ENV, raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    start = START
    _write(root, "src/cart.ts", "export function addItem(cart: Cart, qty: number) {}\n")
    _write(root, "src/billing/pay.ts", "export function pay() {}\n")
    _write(
        root,
        "docs/cart.md",
        "# Cart\n\nCall `addItem(` from `src/cart.ts`. See `src/old/pay.ts`.\n",
    )
    _write(root, "docs/cart.fr.md", "# Panier\n\n`addItem(` dans `src/cart.ts`.\n")
    _write(root, "src/billing/README.md", "# Billing\n\nPayments.\n")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "start", when=start)
    _write(root, "src/cart.ts", CART_TS)
    _git(root, "commit", "-qam", "rename qty", when=start + 40 * DAY)
    return root


def test_the_scan_reports_signatures_moved_files_and_stale_docs(repo: Path):
    report = scan_project(repo, now=START + 100 * DAY)
    by_type = {}
    for issue in report["issues"]:
        by_type.setdefault(issue["driftType"], []).append(issue)

    rename = by_type["signature_mismatch"][0]
    assert rename["docFile"] == "src/cart.ts"
    assert rename["fixId"] == "rename:src/cart.ts:6:qty:quantity"

    moved = by_type["stale_reference"][0]
    assert moved["referencedSymbol"] == "src/old/pay.ts"
    assert moved["fixId"] == "path:docs/cart.md:3:src/old/pay.ts:src/billing/pay.ts"

    stale = {i["docFile"]: i for i in by_type["stale_doc"]}
    assert set(stale) == {
        "docs/cart.md",
        "docs/cart.fr.md",
    }  # the billing README's code never moved
    assert stale["docs/cart.md"]["files"] == ["src/cart.ts"]
    assert stale["docs/cart.md"]["params"]["days"] == 60
    assert stale["docs/cart.md"]["severity"] == "medium"

    fresh = {f["docFile"]: f for f in report["freshness"]}
    assert fresh["docs/cart.fr.md"]["locale"] == "fr"
    assert fresh["src/billing/README.md"]["score"] == 100
    assert fresh["docs/cart.md"]["score"] == freshness_score(["medium"], 60)
    assert report["git"] is True and report["fixable"] == 2


def test_freshness_score():
    assert freshness_score([], None) == 100
    assert freshness_score(["high", "low"], None) == 75
    assert freshness_score([], 0) == 90
    assert freshness_score([], 400) == 60
    assert freshness_score(["high"] * 6, 400) == 0


def test_a_project_without_git_has_no_staleness(tmp_path: Path):
    _write(tmp_path, "README.md", "# x\n")
    report = scan_project(tmp_path)
    assert report["git"] is False
    assert not [i for i in report["issues"] if i["driftType"] == "stale_doc"]


def test_fixes_are_made_where_the_drift_still_is(repo: Path):
    (repo / "docs/cart.md").write_bytes(
        (repo / "docs/cart.md").read_bytes().replace(b"\n", b"\r\n")
    )
    outcome = apply_fixes(
        repo,
        [
            "rename:src/cart.ts:6:qty:quantity",
            "path:docs/cart.md:3:src/old/pay.ts:src/billing/pay.ts",
            "rename:src/cart.ts:6:cart:basket",  # no such drift
            "path:../outside.md:1:a.ts:b.ts",  # outside the project
            "rename:src/cart.ts:6:qty:$(id)",  # not a name
        ],
    )
    assert [a["fixId"] for a in outcome.applied] == [
        "rename:src/cart.ts:6:qty:quantity",
        "path:docs/cart.md:3:src/old/pay.ts:src/billing/pay.ts",
    ]
    assert len(outcome.missing) == 3
    assert "@param quantity how many" in (repo / "src/cart.ts").read_text(
        encoding="utf-8"
    )
    doc = (repo / "docs/cart.md").read_bytes()
    assert b"`src/billing/pay.ts`" in doc and b"\r\n" in doc
    assert parse_fix_id("rename:src/cart.ts:6:qty:$(id)") is None


def test_fixes_never_write_through_a_symlink(repo: Path, tmp_path: Path):
    outside = tmp_path / "outside.ts"
    outside.write_text(CART_TS, encoding="utf-8")
    (repo / "src/link.ts").symlink_to(outside)
    outcome = apply_fixes(repo, ["rename:src/link.ts:6:qty:quantity"])
    assert outcome.applied == []
    assert outside.read_text(encoding="utf-8") == CART_TS


def _branch(repo: Path) -> None:
    _git(repo, "checkout", "-q", "-b", "feature")
    _write(repo, "src/cart.ts", CART_TS.replace("quantity", "count"))
    _git(repo, "commit", "-qam", "change cart")


def test_changed_mode_reports_the_docs_the_change_left_behind(repo: Path):
    _branch(repo)
    report = scan_project(repo, changed={"src/cart.ts"}, use_git=False)
    types = sorted({i["driftType"] for i in report["issues"]})
    assert types == ["doc_not_updated", "signature_mismatch"]
    left = [
        i["docFile"] for i in report["issues"] if i["driftType"] == "doc_not_updated"
    ]
    assert sorted(left) == ["docs/cart.fr.md", "docs/cart.md"]


def test_the_qa_gate_warns_by_default_and_blocks_in_strict(
    repo: Path, tmp_path: Path, monkeypatch
):
    _branch(repo)
    spec = tmp_path / "spec"
    spec.mkdir()
    scope = ChangeScope(
        level="targeted", reason="t", files=("src/cart.ts",), base="develop"
    )

    assert doc_drift_gate(spec, repo, 1, scope) is None
    record = json.loads((spec / RECORD).read_text(encoding="utf-8"))
    assert record["mode"] == "warn" and record["issues"]

    monkeypatch.setenv(DOC_DRIFT_ENV, "strict")
    issues, verdict = doc_drift_gate(spec, repo, 2, scope)
    assert issues[0]["type"] == "doc_drift"
    assert "rejected" in verdict
    request = (spec / "QA_FIX_REQUEST.md").read_text(encoding="utf-8")
    assert "src/cart.ts:6" in request

    monkeypatch.setenv(DOC_DRIFT_ENV, "off")
    assert doc_drift_gate(spec, repo, 3, scope) is None
    assert (
        "disabled"
        in json.loads((spec / RECORD).read_text(encoding="utf-8"))["unchecked"]
    )

    monkeypatch.setenv(DOC_DRIFT_ENV, "typo")
    assert doc_drift_gate(spec, repo, 4, scope) is None  # reads as warn


def test_the_cli_warns_and_only_strict_fails(repo: Path, capsys, monkeypatch):
    _branch(repo)
    assert cli(["check", "--project", str(repo), "--target", "develop"]) == 0
    assert "src/cart.ts:6" in capsys.readouterr().out
    assert (
        cli(["check", "--project", str(repo), "--target", "develop", "--strict"]) == 1
    )
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    assert cli(["check", "--project", str(repo), "--target", "develop"]) == 0
    assert "::warning file=src/cart.ts,line=6::" in capsys.readouterr().out
    assert cli(["check", "--project", str(repo), "--target=--upload-pack=x"]) == 2
    assert cli(["check", "--project", str(repo), "--target", "nope"]) == 2


def test_the_runner_fixes_from_a_list_file(
    repo: Path, tmp_path: Path, capsys, monkeypatch
):
    from runners import doc_drift_runner

    fixes = tmp_path / "fixes.json"
    fixes.write_text(
        json.dumps(["rename:src/cart.ts:6:qty:quantity", 3]), encoding="utf-8"
    )
    monkeypatch.setattr(
        "sys.argv",
        ["doc_drift_runner.py", "--project-path", str(repo), "--fix", str(fixes)],
    )
    doc_drift_runner.main()
    line = next(
        x
        for x in capsys.readouterr().out.splitlines()
        if x.startswith("DOC_DRIFT_FIX:")
    )
    payload = json.loads(line.removeprefix("DOC_DRIFT_FIX:"))
    assert [a["fixId"] for a in payload["applied"]] == [
        "rename:src/cart.ts:6:qty:quantity"
    ]

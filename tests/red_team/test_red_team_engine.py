"""The red team, run for real on a small Python project in a git repository.

The session is a stand-in that writes what a model would: attack tests and
their list. WorkPilot then runs them itself. A programming error escaping the
changed code is a crash; a wrong answer is unexpected; a test that fails once
then passes is flaky and dropped. The code the session edits is put back, and
a later pass replays the same attacks without a session.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from red_team import engine
from red_team.engine import MANIFEST, run_red_team
from suite_runner import runs

SOURCE = (
    "def unit_price(total, quantity):\n"
    "    if quantity < 0:\n"
    "        raise ValueError('negative quantity')\n"
    "    return total / quantity\n"
    "\n"
    "def label(name):\n"
    "    return name.strip().title()\n"
)

ATTACKS = """\
import pytest
from shop import label, unit_price


def test_red_team_zero_quantity():
    assert unit_price(10, 0) == 0


def test_red_team_negative_quantity():
    with pytest.raises(ValueError):
        unit_price(10, -1)


def test_red_team_label_keeps_case_of_acronyms():
    assert label("api key") == "API Key"
"""

MANIFEST_BODY = {
    "attacks": [
        {
            "mode": "edge",
            "test": "test_red_team_zero_quantity",
            "file": "tests/test_shop_red_team.py",
            "target": "shop.unit_price",
            "input": "quantity = 0",
            "expect": "0, not a division error",
        },
        {
            "mode": "fuzz",
            "test": "test_red_team_negative_quantity",
            "file": "tests/test_shop_red_team.py",
            "target": "shop.unit_price",
            "input": "quantity = -1",
            "expect": "ValueError",
        },
        {
            "mode": "fuzz",
            "test": "test_red_team_label_keeps_case_of_acronyms",
            "file": "tests/test_shop_red_team.py",
            "target": "shop.label",
            "input": '"api key"',
            "expect": '"API Key"',
        },
        {"mode": "edge", "test": "test_red_team_not_written", "file": "elsewhere.py"},
    ]
}


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture(autouse=True)
def this_python(monkeypatch):
    # The project's interpreter is this one: pytest is installed here.
    monkeypatch.setattr(runs, "_python", lambda _root: sys.executable)


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "t@example.com")
    _git(root, "config", "user.name", "t")
    (root / "pytest.ini").write_text("[pytest]\npythonpath = .\n", encoding="utf-8")
    (root / "shop.py").write_text(
        "def unit_price(total, quantity):\n    return 0\n", encoding="utf-8"
    )
    (root / "tests").mkdir()
    (root / "tests" / "test_shop.py").write_text(
        "from shop import unit_price\n\ndef test_price():\n    assert unit_price(10, 2) is not None\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    base = _git(root, "rev-parse", "HEAD")
    (root / "shop.py").write_text(SOURCE, encoding="utf-8")  # the task, not committed
    return root, base


def _attacker(written: dict[str, str], manifest: dict = MANIFEST_BODY, calls=None):
    async def session(copy: Path, prompt: str) -> None:
        if calls is not None:
            calls.append(prompt)
        for path, text in written.items():
            (copy / path).parent.mkdir(parents=True, exist_ok=True)
            (copy / path).write_text(text, encoding="utf-8")
        (copy / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")

    return session


async def test_a_crash_an_unexpected_answer_and_a_resistant_attack(repo):
    root, base = repo
    calls: list[str] = []
    session = _attacker(
        {
            "tests/test_shop_red_team.py": ATTACKS,
            # The session "fixes" the code it attacks: that must not count.
            "shop.py": SOURCE.replace("return total / quantity", "return 0"),
        },
        calls=calls,
    )
    report = await run_red_team(root, base, ["shop.py"], session=session)

    assert report.status == "fail", report.reason
    outcomes = {a.test: a.outcome for a in report.attacks}
    assert outcomes == {
        "test_red_team_zero_quantity": "crash",
        "test_red_team_negative_quantity": "resistant",
        "test_red_team_label_keeps_case_of_acronyms": "unexpected",
    }
    assert "ZeroDivisionError" in report.crashes[0].detail
    assert report.restored == ["shop.py"]
    assert list(report.files) == ["tests/test_shop_red_team.py"]
    assert "`shop.py`" in calls[0] and "unit_price" in calls[0]
    # Nothing reached the task's worktree.
    assert not (root / "tests" / "test_shop_red_team.py").exists()
    assert not (root / MANIFEST).exists()
    assert (root / "shop.py").read_text(encoding="utf-8") == SOURCE
    assert _git(root, "worktree", "list").count("\n") == 0


async def test_a_later_pass_replays_the_attacks_without_a_session(repo):
    root, base = repo
    first = await run_red_team(
        root,
        base,
        ["shop.py"],
        session=_attacker({"tests/test_shop_red_team.py": ATTACKS}),
    )
    assert first.status == "fail"

    # The fixer handles a zero quantity; the replay sees it.
    (root / "shop.py").write_text(
        SOURCE.replace(
            "    return total / quantity",
            "    return total / quantity if quantity else 0",
        ),
        encoding="utf-8",
    )
    replay = await run_red_team(
        root, base, ["shop.py"], session=None, previous=first.to_dict()
    )
    assert replay.run == "replay"
    assert replay.status == "pass", replay.reason
    assert {a.test: a.outcome for a in replay.attacks}[
        "test_red_team_zero_quantity"
    ] == "resistant"


async def test_an_attack_that_breaks_in_the_test_itself_is_not_a_crash(repo):
    root, base = repo
    broken = (
        "from shop import unit_price\n\n"
        "def test_red_team_wrong_call():\n"
        "    assert unit_price(10) == 0\n"  # wrong arity: TypeError raised in the test
    )
    manifest = {
        "attacks": [
            {"test": "test_red_team_wrong_call", "file": "tests/test_bad_red_team.py"}
        ]
    }
    report = await run_red_team(
        root,
        base,
        ["shop.py"],
        session=_attacker({"tests/test_bad_red_team.py": broken}, manifest),
    )
    assert [a.outcome for a in report.attacks] == ["unexpected"]
    assert report.status == "pass"


async def test_an_attack_that_fails_only_once_is_flaky(repo):
    root, base = repo
    flaky = (
        "from pathlib import Path\n\n"
        "def test_red_team_sometimes():\n"
        "    marker = Path(__file__).with_suffix('.ran')\n"
        "    first = not marker.exists()\n"
        "    marker.write_text('x')\n"
        "    assert not first\n"
    )
    manifest = {
        "attacks": [
            {"test": "test_red_team_sometimes", "file": "tests/test_flaky_red_team.py"}
        ]
    }
    report = await run_red_team(
        root,
        base,
        ["shop.py"],
        session=_attacker({"tests/test_flaky_red_team.py": flaky}, manifest),
    )
    assert [a.outcome for a in report.attacks] == ["flaky"]
    assert report.status == "unknown"


async def test_no_attack_listed_is_unknown_never_a_pass(repo):
    root, base = repo
    report = await run_red_team(
        root,
        base,
        ["shop.py"],
        session=_attacker({"tests/test_x_red_team.py": ATTACKS}, {"attacks": []}),
    )
    assert report.status == "unknown"


async def test_a_session_that_fails_is_unknown(repo):
    root, base = repo

    async def failing(copy: Path, prompt: str) -> None:
        raise RuntimeError("provider unavailable")

    report = await run_red_team(root, base, ["shop.py"], session=failing)
    assert report.status == "unknown"
    assert "provider unavailable" in report.reason


async def test_a_diff_without_source_has_nothing_to_attack(repo):
    root, base = repo
    (root / "shop.py").write_text(
        "def unit_price(total, quantity):\n    return 0\n", encoding="utf-8"
    )
    (root / "README.md").write_text("docs\n", encoding="utf-8")
    report = await run_red_team(root, base, ["README.md"], session=None)
    assert report.status == "none"


def test_a_replayed_file_outside_the_tests_is_not_written(tmp_path):
    written = engine._write_back(
        tmp_path,
        {
            "shop.py": "evil",
            "../outside_test.py": "x",
            "tests/test_ok_red_team.py": "ok",
        },
    )
    assert written == ["tests/test_ok_red_team.py"]
    assert not (tmp_path / "shop.py").exists()

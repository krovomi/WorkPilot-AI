"""A stand-in `gh` binary, on whichever platform the suite is running.

The GitHub runners shell out to `gh` (`core.gh_executable` finds it through
`GITHUB_CLI_PATH` first). Tests that start a runner the way the desktop app
does need a `gh` that answers chosen commands and records what it was asked,
without a network or an account.

The fake is a small Python program, launched by a shebang script on POSIX and
by a `.cmd` file on Windows (no `#!` there, see `rtk_fake.py`). Its answers are
a JSON file: the longest key that prefixes the joined arguments wins.

It runs isolated (`-I -S`): no site hooks, so a suite measured with coverage
(`patch = subprocess` loads coverage in every child through a `.pth`) does not
make the fake print coverage's warnings on its stderr, which the runners
relay as gh's own error text.

    gh = write_fake_gh(tmp_path, {"auth token": {"stdout": "t0k"},
                                  "issue list": {"stdout": "[]"}})
    env["GITHUB_CLI_PATH"] = str(gh.path)
    ...
    assert gh.calls()[0][:2] == ["issue", "list"]
"""

from __future__ import annotations

import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

__all__ = ["FakeGh", "write_fake_gh"]

_PROGRAM = """
import json, os, sys, time
from pathlib import Path
# gh writes UTF-8 and bare LF; `-I` ignores PYTHONUTF8, so say it here
# (Windows: cp1252, and a text stream turns each "\\n" into "\\r\\n").
sys.stdout.reconfigure(encoding="utf-8", newline="\\n")
sys.stderr.reconfigure(encoding="utf-8", newline="\\n")
here = Path(__file__).parent
args = sys.argv[1:]
with open(here / "gh-calls.jsonl", "a", encoding="utf-8") as log:
    log.write(json.dumps(args) + "\\n")
with open(here / "gh-repos.jsonl", "a", encoding="utf-8") as log:
    log.write(json.dumps(os.environ.get("GH_REPO")) + "\\n")
answers = json.loads((here / "gh-answers.json").read_text(encoding="utf-8"))
joined = " ".join(args)
keys = sorted((k for k in answers if joined == k or joined.startswith(k + " ")), key=len)
answer = answers[keys[-1]] if keys else {"stderr": "fake gh: no answer for " + joined, "code": 1}
time.sleep(answer.get("sleep", 0))
sys.stdout.write(answer.get("stdout", ""))
sys.stderr.write(answer.get("stderr", ""))
sys.exit(answer.get("code", 0))
"""


@dataclass
class FakeGh:
    path: Path
    directory: Path

    def calls(self) -> list[list[str]]:
        log = self.directory / "gh-calls.jsonl"
        if not log.exists():
            return []
        return [
            json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()
        ]

    def repos(self) -> list[str | None]:
        """The GH_REPO each call ran with, in the order of `calls()` (None: unset)."""
        log = self.directory / "gh-repos.jsonl"
        if not log.exists():
            return []
        return [
            json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()
        ]

    def answer(self, answers: dict[str, dict]) -> None:
        (self.directory / "gh-answers.json").write_text(
            json.dumps(answers), encoding="utf-8"
        )


def write_fake_gh(directory: Path, answers: dict[str, dict]) -> FakeGh:
    """Write an executable fake `gh` in `directory` and return it.

    Each answer is ``{"stdout": str, "stderr": str, "code": int, "sleep": float}``
    (all optional; ``sleep`` makes the call hang that many seconds before it
    answers). A command without an answer fails with exit code 1.
    """
    directory.mkdir(parents=True, exist_ok=True)
    program = directory / "fake_gh.py"
    program.write_text(_PROGRAM, encoding="utf-8")
    fake = FakeGh(
        path=directory / ("gh.cmd" if os.name == "nt" else "gh"), directory=directory
    )
    fake.answer(answers)
    if os.name == "nt":
        fake.path.write_text(
            f'@"{sys.executable}" -I -S "{program}" %*\r\n', encoding="utf-8"
        )
    else:
        fake.path.write_text(
            f'#!/bin/sh\nexec "{sys.executable}" -I -S "{program}" "$@"\n',
            encoding="utf-8",
        )
        fake.path.chmod(fake.path.stat().st_mode | stat.S_IEXEC)
    return fake

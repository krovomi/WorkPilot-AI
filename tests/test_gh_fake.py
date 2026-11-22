"""The fake `gh` of tests/gh_fake.py answers byte for byte like the real one.

The real `gh` (a Go program) writes UTF-8 and bare LF on every platform. A
Python text stream on Windows turns each "\\n" into "\\r\\n", so a fake left in
text mode handed the runners a diff the real CLI never sends.
"""

from __future__ import annotations

import subprocess

from tests.gh_fake import write_fake_gh


def test_the_fake_writes_its_answer_as_is(tmp_path):
    answer = "diff --git a/x b/x\n+é\n"
    fake = write_fake_gh(
        tmp_path / "gh", {"pr diff": {"stdout": answer, "stderr": "warn\n"}}
    )
    done = subprocess.run(
        [str(fake.path), "pr", "diff", "7"], capture_output=True, check=False
    )
    assert done.returncode == 0
    assert done.stdout == answer.encode("utf-8")
    assert done.stderr == b"warn\n"
    assert fake.calls() == [["pr", "diff", "7"]]

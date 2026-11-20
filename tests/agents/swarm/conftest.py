"""A backend stand-in for the swarm's subtask processes.

The wave executor starts ``<source>/run.py --spec <spec> --subtask <id>`` in
the project. Here ``run.py`` does what ``swarm_plan.json`` in the project says
for that subtask and attempt, and leaves the attempt count and what it was
told under ``attempts/``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

RUN_PY = r"""
import json, os, sys, time
from pathlib import Path

subtask = sys.argv[sys.argv.index("--subtask") + 1]
spec = sys.argv[sys.argv.index("--spec") + 1]
attempts = Path("attempts")
attempts.mkdir(exist_ok=True)
counter = attempts / subtask
attempt = int(counter.read_text(encoding="utf-8")) if counter.exists() else 0
counter.write_text(str(attempt + 1), encoding="utf-8")
plan = json.loads(Path("swarm_plan.json").read_text(encoding="utf-8"))
steps = plan[subtask]
step = steps[min(attempt, len(steps) - 1)]
seen = {
    "spec": spec,
    "mode": os.environ.get("SWARM_MODE"),
    "subtask": os.environ.get("SWARM_SUBTASK_ID"),
    "wave": os.environ.get("SWARM_WAVE_INDEX"),
}
(attempts / (subtask + ".env.json")).write_text(json.dumps(seen), encoding="utf-8")
if step == "ok":
    print("working on " + subtask, flush=True)
    print('__EXEC_PHASE__:{"phase": "coding"}', flush=True)
    sys.exit(0)
if step == "fail":
    # More than a pipe buffer on stderr: the executor must keep reading it.
    # A warning comes first and the error last, as an interpreter writes them.
    sys.stderr.write("a warning\n" + "E" * 100_000 + "\nboom: the real error")
    sys.exit(1)
if step == "silent":
    sys.exit(3)
if step == "crlf":
    # What a worker's text-mode stderr holds on Windows, on every OS.
    sys.stderr.buffer.write(b"Traceback\r\nboom: the real error\r\n")
    sys.exit(1)
if step == "long":
    # One event longer than a pipe buffer, then a last line with no line end.
    print('__TASK_EVENT__:{"diff": "' + "d" * 100_000 + '"}', flush=True)
    sys.stdout.write("last words")
    sys.exit(0)
if step == "hang":
    print("started", flush=True)
    time.sleep(60)
"""


@pytest.fixture
def world(tmp_path: Path) -> dict[str, Path]:
    source = tmp_path / "backend"
    source.mkdir()
    (source / "run.py").write_text(RUN_PY, encoding="utf-8")
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "002-cart"
    spec.mkdir(parents=True)
    return {"source": source, "project": project, "spec": spec}

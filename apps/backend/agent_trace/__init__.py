"""Who wrote each line of a task: the Agent Trace record (killer feature F3).

See ``docs/architecture/agent-trace.md``. Collection is passive: no agent gets
a new tool, git is the source of truth, and nothing here can fail a build.
"""

from __future__ import annotations

from .record import SPEC_VERSION, TRACE_FILE, build_record, read_records, record_session
from .session import model_id_of, note_tool_write, session_start
from .summary import SUMMARY_FILE, attribution_line, summarize, write_summary


def after_session(
    project_dir,
    spec_dir,
    base: str | None,
    head: str | None,
    model_id: str | None,
    subtask_id: str | None = None,
    session: int | None = None,
    source_spec_dir=None,
) -> None:
    """Record the session's commit range, then refresh the task's summary."""
    if record_session(
        project_dir,
        spec_dir,
        base=base,
        head=head,
        model_id=model_id,
        subtask_id=subtask_id,
        session=session,
        copies=(source_spec_dir,),
    ):
        write_summary(project_dir, spec_dir, source_spec_dir)


__all__ = [
    "SPEC_VERSION",
    "SUMMARY_FILE",
    "TRACE_FILE",
    "after_session",
    "attribution_line",
    "build_record",
    "model_id_of",
    "note_tool_write",
    "read_records",
    "record_session",
    "session_start",
    "summarize",
    "write_summary",
]

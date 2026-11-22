"""The tokens each server run and job used, stored by the server.

A run is started with the write end of a pipe (``WORKPILOT_USAGE_FD``, see
``foundation/usage_channel.py`` on the run's side). Each agent session the
run ends writes one JSON line there; :class:`UsageChannel` reads the other
end while the run lives and :func:`store` keeps each checked line as a
:class:`~server.db.models.UsageRecord`, against the run or job, the person
who started it, its project and its organization.

What a line says is the run's account, so it is checked as input: a closed
shape, bounded strings and numbers, at most :data:`MAX_LINES` per process. A
line that does not fit is dropped, never stored in part. Totals only: no
prompt, no answer, no path ever travels on the channel.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime

from server.db.engine import get_session_factory
from server.db.models import AgentRun, Project, UsageRecord
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

#: The variable the run reads (``foundation.usage_channel.USAGE_FD_ENV``; the
#: server imports no backend unit, ``tests/test_import_contracts.py``).
USAGE_FD_ENV = "WORKPILOT_USAGE_FD"

#: Longer than any honest line (``foundation.usage_channel.MAX_LINE_BYTES``).
MAX_LINE_BYTES = 4096
#: Sessions one process may report; a run has a few dozen at most.
MAX_LINES = 2000
#: Fits the ``Integer`` columns, far above one session's tokens.
MAX_TOKENS = 2_000_000_000
#: One session's cost, in dollars; ``cost_micro_usd`` must fit an Integer.
MAX_COST_USD = 2000.0

_NAME = re.compile(r"^[a-z0-9_-]{1,40}$")
_PROVIDER = re.compile(r"^[A-Za-z0-9._-]{0,40}$")
_MODEL = re.compile(r"^[A-Za-z0-9._:/@+-]{0,120}$")
_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_write_tokens",
    "cache_read_tokens",
)


@dataclass(frozen=True)
class UsageLine:
    phase: str
    agent_type: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    cost_micro_usd: int
    estimated: bool

    @property
    def total_tokens(self) -> int:
        return (
            self.input_tokens
            + self.output_tokens
            + self.cache_write_tokens
            + self.cache_read_tokens
        )


def _count(value: object) -> int | None:
    # bool is an int: ``true`` is not a token count.
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= MAX_TOKENS else None


def parse_line(raw: bytes) -> UsageLine | None:
    """The usage line ``raw``, checked, or None when it does not fit."""
    if len(raw) > MAX_LINE_BYTES:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    phase = data.get("phase")
    agent_type = data.get("agent_type", "")
    provider = data.get("provider", "")
    model = data.get("model", "")
    if not (isinstance(phase, str) and _NAME.match(phase)):
        return None
    if not (
        isinstance(agent_type, str) and (agent_type == "" or _NAME.match(agent_type))
    ):
        return None
    if not (isinstance(provider, str) and _PROVIDER.match(provider)):
        return None
    if not (isinstance(model, str) and _MODEL.match(model)):
        return None
    counts = {name: _count(data.get(name, 0)) for name in _TOKEN_FIELDS}
    if any(value is None for value in counts.values()):
        return None
    cost = data.get("cost_usd", 0)
    if isinstance(cost, bool) or not isinstance(cost, int | float):
        return None
    if not 0 <= cost <= MAX_COST_USD:  # also refuses NaN
        return None
    estimated = data.get("estimated", False)
    if not isinstance(estimated, bool):
        return None
    return UsageLine(
        phase=phase,
        agent_type=agent_type,
        provider=provider.lower(),
        model=model,
        input_tokens=counts["input_tokens"] or 0,
        output_tokens=counts["output_tokens"] or 0,
        cache_write_tokens=counts["cache_write_tokens"] or 0,
        cache_read_tokens=counts["cache_read_tokens"] or 0,
        cost_micro_usd=round(float(cost) * 1_000_000),
        estimated=estimated,
    )


@dataclass(frozen=True)
class UsageOwner:
    """Who and what a process's usage belongs to."""

    org_id: str
    project_id: str
    user_id: str | None
    run_id: str | None = None
    job_id: str | None = None


async def owner_of(
    project_id: str,
    user_id: str | None,
    *,
    run_id: str | None = None,
    job_id: str | None = None,
) -> UsageOwner | None:
    """The owner of a run or job of ``project_id``, or None for no project."""
    async with get_session_factory()() as db:
        org_id = await db.scalar(select(Project.org_id).where(Project.id == project_id))
    if org_id is None:
        return None
    return UsageOwner(org_id, project_id, user_id, run_id=run_id, job_id=job_id)


async def store(owner: UsageOwner, line: UsageLine) -> None:
    """Keep ``line`` for ``owner``; a run without a provider takes this one."""
    async with get_session_factory()() as db:
        db.add(
            UsageRecord(
                org_id=owner.org_id,
                project_id=owner.project_id,
                user_id=owner.user_id,
                run_id=owner.run_id,
                job_id=owner.job_id,
                phase=line.phase,
                agent_type=line.agent_type,
                provider=line.provider,
                model=line.model,
                input_tokens=line.input_tokens,
                output_tokens=line.output_tokens,
                cache_write_tokens=line.cache_write_tokens,
                cache_read_tokens=line.cache_read_tokens,
                cost_micro_usd=line.cost_micro_usd,
                estimated=line.estimated,
            )
        )
        if owner.run_id is not None:
            run = await db.get(AgentRun, owner.run_id)
            if run is not None:
                run.provider = run.provider or line.provider or None
                run.model = run.model or line.model or None
        await db.commit()


async def tokens_since(db: AsyncSession, org_id: str, since: datetime) -> int:
    """Every token the organization's runs and jobs used since ``since``."""
    total = await db.scalar(
        select(
            func.coalesce(
                func.sum(
                    UsageRecord.input_tokens
                    + UsageRecord.output_tokens
                    + UsageRecord.cache_write_tokens
                    + UsageRecord.cache_read_tokens
                ),
                0,
            )
        ).where(UsageRecord.org_id == org_id, UsageRecord.created_at >= since)
    )
    return int(total or 0)


class UsageChannel:
    """The pipe a run reports its sessions on.

    ``env`` and ``pass_fds`` go to the process; :meth:`started` closes the
    server's copy of the write end, so the read side ends when the run
    exits; :meth:`collect` reads and stores until then.

    A descriptor handed to a child is POSIX: elsewhere (a Windows developer
    machine; the server itself runs on Linux) the channel is empty and the
    run reports nothing. The ``server`` package imports no backend unit, so
    this test cannot go through ``foundation.platform``.
    """

    def __init__(self, owner: UsageOwner | None) -> None:
        self.owner = owner
        self._read: int | None = None
        self._write: int | None = None
        if owner is not None and os.name == "posix":
            self._read, self._write = os.pipe()

    @property
    def env(self) -> dict[str, str]:
        return {} if self._write is None else {USAGE_FD_ENV: str(self._write)}

    @property
    def pass_fds(self) -> tuple[int, ...]:
        return () if self._write is None else (self._write,)

    def started(self) -> None:
        """The process holds its copy: drop the server's."""
        if self._write is not None:
            os.close(self._write)
            self._write = None

    def close(self) -> None:
        """Release both ends; safe to call more than once."""
        self.started()
        if self._read is not None:
            os.close(self._read)
            self._read = None

    async def collect(self) -> int:
        """Store each line until the run closes its end; the count stored.

        Cancelling it (a descendant of the run kept the pipe open after the
        run ended) stops the reading at once and keeps what was stored.
        """
        if self._read is None or self.owner is None:
            return 0
        owner = self.owner
        fd, self._read = self._read, None
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=MAX_LINE_BYTES)
        transport, _ = await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader),
            os.fdopen(fd, "rb", buffering=0),
        )
        seen = stored = 0
        try:
            while seen < MAX_LINES:
                try:
                    raw = await reader.readline()
                except ValueError:
                    # A line past the limit: dropped, the next one is read.
                    seen += 1
                    continue
                if not raw:
                    break
                raw = raw.rstrip(b"\n")
                if not raw:
                    continue
                seen += 1
                line = parse_line(raw)
                if line is None:
                    logger.warning("A usage line of %s was refused", self._label())
                    continue
                try:
                    await store(owner, line)
                except SQLAlchemyError:
                    # Accounting never fails a run.
                    logger.exception("A usage line of %s was not stored", self._label())
                    continue
                stored += 1
        finally:
            transport.close()
        return stored

    def _label(self) -> str:
        if self.owner is not None and self.owner.run_id:
            return f"run {self.owner.run_id}"
        return f"job {self.owner.job_id if self.owner else None}"


#: How long the reading may outlast the process: a descendant that kept the
#: pipe open must not hold the run (or job) open.
COLLECT_GRACE_SECONDS = 5.0


async def usage_channel(
    project_id: str,
    user_id: str | None,
    *,
    run_id: str | None = None,
    job_id: str | None = None,
) -> UsageChannel:
    """The channel of a run or job; an empty one when the project is gone."""
    owner = await owner_of(project_id, user_id, run_id=run_id, job_id=job_id)
    if owner is None:
        return UsageChannel(None)
    return UsageChannel(owner)


async def finish_collecting(task: asyncio.Task[int]) -> None:
    """Wait for ``task`` after its process ended, a few seconds at most."""
    try:
        await asyncio.wait_for(task, timeout=COLLECT_GRACE_SECONDS)
    except TimeoutError:
        logger.warning("A run's usage channel stayed open after it ended")

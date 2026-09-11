"""Can hermes-agent actually learn from this checkout — and if not, what is missing.

The same shape as `mobile/readiness.py`, for the same reason. A learning loop
that silently does nothing is worse than one that is off: the candidates never
appear, nobody notices, and the conclusion drawn six weeks later is "hermes
doesn't work here". Every one of the conditions below is answerable from files
on disk in milliseconds — no model, no network, no subprocess that can hang —
so the honest design is to answer *before* the phase runs and say which step is
missing, rather than to discover it from an empty report.

The five conditions, and why each is separate
---------------------------------------------
``install``   hermes on PATH or a hermes home on disk. Absent means the whole
              feature is simply not in use here, which is not a defect and must
              not be reported as one.
``soul``      ``<HERMES_HOME>/SOUL.md``. Optional: hermes runs without a
              persona. Reported because a WorkPilot-shaped agent is the point
              of installing the one this repository offers.
``trust``     the checkout listed in ``skills.trusted_project_dirs``. This is
              the condition that fails silently, every time, on a fresh clone —
              hermes loads no project skills until a person runs
              ``hermes skills trust``, and nothing in this repository may make
              that decision for them.
``skills``    ``.agents/skills/`` exists and is populated. It is generated, so
              an empty one means `skills:build` has not been run, not that
              hermes is misconfigured.
``agents``    ``AGENTS.md`` at the git root — the project-context file hermes
              injects. Committed here, so it fails only in a broken checkout.

``install`` is the only blocker. The rest degrade: the loop still ingests what
hermes authored elsewhere, which is exactly the experience from outside this
repository that makes the integration worth having.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from .home import hermes_config_path, hermes_home, is_trusted
from .soul import soul_status

__all__ = ["Check", "HermesReport", "doctor"]

_TRUST_REMEDY = "cd <project> && hermes skills trust"


@dataclass(frozen=True)
class Check:
    """One condition that either holds or does not."""

    name: str
    ok: bool
    detail: str = ""
    remedy: str = ""
    required: bool = False
    """A failing required check means the loop cannot run at all."""

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "remedy": self.remedy,
            "required": self.required,
        }


@dataclass(frozen=True)
class HermesReport:
    """Whether the hermes learning loop can run here, and what is missing."""

    installed: bool
    home: Path
    checks: tuple[Check, ...]

    @property
    def blockers(self) -> tuple[Check, ...]:
        return tuple(c for c in self.checks if c.required and not c.ok)

    @property
    def warnings(self) -> tuple[Check, ...]:
        return tuple(c for c in self.checks if not c.required and not c.ok)

    @property
    def ready(self) -> bool:
        return not self.blockers

    @property
    def degraded(self) -> bool:
        """Runnable, but not doing everything it could."""
        return self.ready and bool(self.warnings)

    @property
    def state(self) -> str:
        if not self.installed:
            return "absent"
        return "degraded" if self.degraded else "ready"

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "installed": self.installed,
            "ready": self.ready,
            "degraded": self.degraded,
            # The hermes home is the user's own directory on their own machine
            # and the remedies are useless without it; it is never a path a
            # caller supplied, so echoing it confines nothing.
            "home": str(self.home),
            "checks": [c.to_dict() for c in self.checks],
        }

    def describe(self) -> str:
        """One line per unmet condition, for a build log."""
        if not self.installed:
            return "hermes: not installed here"
        lines = [f"hermes: {self.state}"]
        for check in self.warnings + self.blockers:
            lines.append(f"  {check.name}: {check.detail or 'missing'}")
            if check.remedy:
                lines.append(f"    -> {check.remedy}")
        return "\n".join(lines)


def _executable() -> str | None:
    return shutil.which("hermes")


def doctor(project_root: Path, home: Path | None = None) -> HermesReport:
    """Read the five conditions. Never raises, never blocks."""
    resolved_home = home or hermes_home()
    binary = _executable()
    home_exists = resolved_home.is_dir()
    installed = bool(binary) or home_exists

    checks: list[Check] = [
        Check(
            name="install",
            ok=installed,
            detail=(
                f"hermes on PATH ({binary})"
                if binary
                else f"hermes home at {resolved_home}"
                if home_exists
                else "no hermes binary and no hermes home"
            ),
            remedy=(
                ""
                if installed
                else "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
            ),
            required=True,
        )
    ]

    if not installed:
        # Nothing below this line has a meaningful answer, and reporting four
        # further failures for a tool the user never installed is noise.
        return HermesReport(installed=False, home=resolved_home, checks=tuple(checks))

    soul = soul_status(home=resolved_home)
    checks.append(
        Check(
            name="soul",
            ok=soul.installed,
            detail={
                "installed": "the persona offered here is installed",
                "diverged": "a different persona is installed",
                "not-installed": "no SOUL.md in the hermes home",
                "unavailable": "this repository ships no SOUL.md",
            }[soul.state],
            remedy=(
                ""
                if soul.installed
                else "python3 runners/hermes_runner.py --action install-soul"
            ),
        )
    )

    trusted = is_trusted(project_root, resolved_home)
    checks.append(
        Check(
            name="trust",
            ok=trusted,
            detail=(
                "this checkout is trusted"
                if trusted
                else f"not listed in skills.trusted_project_dirs ({hermes_config_path(resolved_home)})"
            ),
            # Deliberately a command for a person, not an action with a button.
            # Trusting a checkout means every SKILL.md in it becomes a procedure
            # hermes will follow; software that grants itself that is the
            # prompt-injection vector the gate exists to close.
            remedy="" if trusted else _TRUST_REMEDY,
        )
    )

    skills_dir = Path(project_root) / ".agents" / "skills"
    populated = skills_dir.is_dir() and any(skills_dir.glob("*/SKILL.md"))
    checks.append(
        Check(
            name="skills",
            ok=populated,
            detail=(
                f"{len(list(skills_dir.glob('*/SKILL.md')))} skill(s) in .agents/skills"
                if populated
                else ".agents/skills is missing or empty"
            ),
            remedy="" if populated else "pnpm run skills:build",
        )
    )

    agents_md = Path(project_root) / "AGENTS.md"
    checks.append(
        Check(
            name="agents",
            ok=agents_md.is_file(),
            detail=(
                "AGENTS.md is the project context hermes injects"
                if agents_md.is_file()
                else "no AGENTS.md at the project root"
            ),
        )
    )

    return HermesReport(installed=True, home=resolved_home, checks=tuple(checks))

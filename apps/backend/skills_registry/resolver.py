"""Deciding which skills a project actually gets.

Three gates, in order. A skill has to clear all three:

1. **Pack selection and pin** — ``skills.toml``'s ``[packs]`` table is a
   *want-list*: a pack it does not name is not resolved at all, and a pack it
   pins to ``^1`` is out at 2.0.0. The pin is the axis that lets a project stay
   on an older pack while newer ones ship.

   Opt-in rather than opt-out, and the reason is mechanical. `skills/` holds
   packs vendored on demand whose content is gitignored: with opt-out, the
   emitted set would depend on whether the developer had run
   `skills:bootstrap`, so `skills:check` would pass on a fresh clone and fail
   for anyone who had. The build output has to be a function of what is
   committed, and the want-list is the committed part.

   Before the pin is checked, the pack's *variant* is chosen. A pack that has
   forked keeps its older cuts in subdirectories with the targets they were
   written for, so a project on .NET 8 resolves to the .NET 8 variant rather
   than to nothing. Which cut applies is decided by the project's toolchain;
   the pin is then evaluated against that cut's version, because pinning
   ``^2`` means "the 2.x line", not "the 2.x line of whatever the root happens
   to be today".
2. **Toolchain targets** — the skill's content has to apply to what the project
   is on. This is the axis that keeps .NET 10 guidance away from a .NET
   Framework 4.8 codebase.
3. **Runtime prerequisites** — ``requires`` must be satisfiable *right now*.

Gate 3 is what fixes the failure this whole registry was built for: 76 BMAD
skills were committed pointing at ``_bmad/core/tasks/workflow.xml``, a path that
is gitignored and absent from a fresh clone. They were listed in the command
palette and every one of them failed on invocation. A skill whose runtime is
missing is not emitted at all, so the palette shows what actually works.

Every rejection carries a reason. ``skills-cli why`` prints them, because "my
skill disappeared" with no explanation is its own kind of broken.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .packs import Pack, SkillSource
from .project import ProjectConfig
from .targets import satisfies, targets_match

__all__ = ["Resolution", "Rejection", "resolve", "check_requires"]


@dataclass(frozen=True)
class Rejection:
    """One skill that did not make it, and why."""

    name: str
    kind: str
    pack: str
    gate: str
    """``pack-pin`` | ``targets`` | ``requires`` | ``name-collision``"""
    reason: str


@dataclass
class Resolution:
    selected: list[SkillSource] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    packs: dict[str, Pack] = field(default_factory=dict)
    """Packs that cleared gate 1, by name — the build needs their versions."""

    def by_name(self) -> dict[str, SkillSource]:
        return {s.name: s for s in self.selected}

    def rejections_for(self, name: str) -> list[Rejection]:
        return [r for r in self.rejected if r.name == name]


def check_requires(requires: dict[str, Any], project_dir: Path) -> tuple[bool, str]:
    """Verify a skill's runtime prerequisites.

    Supported keys:

    ``runtime``
        A path, relative to the project root, that must exist. Used for skills
        that drive a vendored runtime (BMAD's ``workflow.xml``).
    ``command``
        An executable that must be on ``PATH``.

    An unknown key is a hard failure rather than a silent pass: a typo in
    ``requires`` must not quietly turn the gate off.

    ``runtime`` is confined to the project directory. The value comes from a
    ``SKILL.md``, and since packs are vendored from upstream that is
    third-party content: without the check, `runtime: "../../.ssh/id_rsa"`
    would turn this gate into a filesystem probe, reporting through the
    command palette whether a file exists anywhere the backend can reach.
    """
    for key, value in requires.items():
        if key == "runtime":
            target = _within(project_dir, str(value))
            if target is None:
                return False, f"runtime escapes the project directory: {value}"
            if not target.exists():
                return False, f"runtime not present: {value}"
        elif key == "command":
            # A list means alternatives: `python3` on Unix, `python` on
            # Windows. Any one of them being present satisfies the gate.
            candidates = value if isinstance(value, list) else [value]
            if not any(shutil.which(str(c)) for c in candidates):
                return (
                    False,
                    f"none of these commands is on PATH: {', '.join(map(str, candidates))}",
                )
        else:
            return False, f"unknown requires key: {key!r}"
    return True, ""


def _pack_order(packs: list[Pack], config: ProjectConfig) -> list[Pack]:
    """Packs in the order that decides who wins a name collision.

    A project's ``[packs]`` list is written by hand, so its order is a
    statement of preference: a project that lists ``superpowers`` before
    ``hermes`` has said which one it wants when both offer
    ``test-driven-development``. Packs it does not list keep their incoming
    order, which is alphabetical, so the outcome is deterministic either way
    and never depends on filesystem iteration.
    """
    if not config.packs:
        return list(packs)
    preference = {name: i for i, name in enumerate(config.packs)}
    return sorted(
        packs, key=lambda p: (preference.get(p.name, len(preference)), p.name)
    )


def resolve(
    packs: list[Pack],
    config: ProjectConfig,
    *,
    ignore_requires: bool = False,
) -> Resolution:
    """Run the gates over every skill in ``packs``.

    ``ignore_requires`` skips the requires gate. It exists for ``skills-cli
    list``, which should be able to show what a project *would* get once its
    runtimes are bootstrapped — not for the build, which must only emit what
    works.

    The last gate is **name collision**, and it exists because the build keys
    its output on the skill name: `.agents/skills/<name>/SKILL.md`. Two packs
    providing the same name therefore used to produce one file whose content
    depended on which pack was iterated last — alphabetical order, silently.
    That was survivable while the tracked upstreams happened not to overlap;
    it stops being survivable the moment a fifth pack is added, since several
    of them are adaptations of each other and share skill names on purpose.

    The loser is rejected with a reason naming the winner, so `skills-cli why`
    can answer "where did my skill go" instead of the answer being "nowhere,
    and nobody noticed".
    """
    result = Resolution()
    claimed: dict[tuple[str, str], str] = {}

    for declared in _pack_order(packs, config):
        pack = (
            declared.resolve_variant(config.targets) if declared.variants else declared
        )
        if pack is None:
            for src in declared.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        declared.name,
                        "targets",
                        f"no variant of {declared.name} targets this toolchain "
                        f"({_describe(declared.targets)}; "
                        f"variants: {', '.join(v.dir for v in declared.variants)})",
                    )
                )
            continue

        if config.packs and pack.name not in config.packs:
            for src in pack.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        pack.name,
                        "pack-pin",
                        f"pack {pack.name} is not listed in this project's "
                        f"[packs] — add it to .workpilot/skills.toml to use it",
                    )
                )
            continue

        pin = config.packs.get(pack.name)
        if pin and pin != "latest" and not satisfies(pack.version, pin):
            for src in pack.skills():
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        pack.name,
                        "pack-pin",
                        f"pack {pack.name} {pack.version} does not satisfy pin {pin}",
                    )
                )
            continue

        result.packs[pack.name] = pack

        for src in pack.skills():
            ok, reason = targets_match(src.targets, config.targets)
            if not ok:
                result.rejected.append(
                    Rejection(src.name, src.kind, pack.name, "targets", reason)
                )
                continue

            if not ignore_requires and src.requires:
                ok, reason = check_requires(src.requires, config.project_dir)
                if not ok:
                    result.rejected.append(
                        Rejection(src.name, src.kind, pack.name, "requires", reason)
                    )
                    continue

            owner = claimed.get((src.kind, src.name))
            if owner is not None:
                result.rejected.append(
                    Rejection(
                        src.name,
                        src.kind,
                        pack.name,
                        "name-collision",
                        f"pack {owner!r} already provides a {src.kind} named "
                        f"{src.name!r}, and the build emits one file per name. "
                        f"List the pack you want first in [packs], or stop "
                        f"vendoring the duplicate.",
                    )
                )
                continue
            claimed[(src.kind, src.name)] = pack.name

            result.selected.append(src)

    result.selected.sort(key=lambda s: (s.kind, s.name))
    return result


def _within(root: Path, relative: str) -> Path | None:
    """Resolve ``relative`` under ``root``, or None if it escapes.

    Absolute paths escape by definition and are rejected too — a `requires`
    entry describes something inside the project, so an absolute one is
    either a mistake or an attempt.
    """
    candidate = Path(relative)
    if candidate.is_absolute():
        return None
    try:
        resolved = (root / candidate).resolve()
        resolved.relative_to(root.resolve())
    except (ValueError, OSError):
        return None
    return resolved


def _describe(targets: dict[str, str]) -> str:
    return ", ".join(f"{k} {v}" for k, v in sorted(targets.items())) or "no targets"

#!/usr/bin/env python3
"""skills-cli — the one thing that writes materialised skills.

    pnpm run skills:build          # write every enabled harness output
    pnpm run skills:check          # fail if the outputs are stale (CI gate)
    pnpm run skills:list           # what this project resolves to, and why not
    python scripts/skills_cli.py why <skill>

One authored skill in `skills/` becomes N files: `.agents/skills/` (the source
the backend serves to the Kanban palette, and the path Copilot/Codex/Cursor/
Amp/Gemini read natively), plus whichever harness mirrors are enabled.

Why Python and not Node, given the rest of `scripts/` is split: the build has
to *emit* YAML frontmatter, read TOML config and compare semver ranges. Node
has none of the three available here, so it would mean three new dependencies
on a root package.json that has five — or a hand-written YAML emitter, which is
precisely the class of code this registry exists to delete. PyYAML is declared
and `tomllib` is in the stdlib, so the Python side costs nothing. CI already
invokes `python3 scripts/update-readme.py` the same way.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from skills_registry.build import (  # noqa: E402
    apply_build,
    plan_build,
)
from skills_registry.harnesses import load_harnesses  # noqa: E402
from skills_registry.packs import PackError, load_packs  # noqa: E402
from skills_registry.project import load_project_config  # noqa: E402
from skills_registry.resolver import resolve  # noqa: E402

from workflows import WorkflowError  # noqa: E402

SKILLS_ROOT = REPO_ROOT / "skills"


def _resolve_harnesses(explicit: str | None, config_harnesses: list[str]) -> list[str]:
    matrix = load_harnesses(REPO_ROOT)
    if explicit:
        return [h.strip() for h in explicit.split(",") if h.strip()]
    if config_harnesses:
        return config_harnesses
    return [name for name, h in matrix.items() if h.default]


def _load(project_dir: Path):
    packs = load_packs(SKILLS_ROOT)
    config = load_project_config(project_dir)
    return packs, config


def cmd_build(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    harness_names = _resolve_harnesses(args.harness, config.harnesses)
    resolution = resolve(packs, config)
    plan = plan_build(REPO_ROOT, resolution, harness_names)
    # Outputs land in the consuming project; packs are read from this repo.
    result = apply_build(
        project_dir,
        resolution,
        plan,
        harness_names,
        source_root=REPO_ROOT,
        check_only=args.check,
    )

    if args.check:
        if result.changed:
            print("skills:check — outputs are stale.", file=sys.stderr)
            for rel in result.written:
                print(f"  would write   {rel}", file=sys.stderr)
            for rel in result.removed:
                print(f"  would remove  {rel}", file=sys.stderr)
            print(
                "\nRun `pnpm run skills:build` and commit the result.",
                file=sys.stderr,
            )
            return 1
        print(
            f"skills:check — OK, {len(result.unchanged)} file(s) up to date "
            f"across harness(es): {', '.join(sorted(harness_names))}."
        )
        return 0

    print(
        f"skills:build — {len(resolution.selected)} skill(s)/agent(s) "
        f"→ {project_dir} "
        f"[harness: {', '.join(sorted(harness_names))}]"
    )
    for rel in result.written:
        print(f"  wrote    {rel}")
    for rel in result.removed:
        print(f"  removed  {rel}")
    if not result.changed:
        print("  (already up to date)")
    if resolution.rejected:
        print(
            f"\n  {len(resolution.rejected)} not emitted — `skills:list` explains why"
        )
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    resolution = resolve(packs, config)

    print(f"project: {project_dir}")
    if config.targets:
        parts = [
            f"{k}={v} ({config.target_source(k)})"
            for k, v in sorted(config.targets.items())
        ]
        print(f"targets: {', '.join(parts)}")
    else:
        print("targets: none detected and none declared in .workpilot/skills.toml")
    if config.packs:
        print(
            f"pins:    {', '.join(f'{k}={v}' for k, v in sorted(config.packs.items()))}"
        )

    print(f"\nselected ({len(resolution.selected)}):")
    for src in resolution.selected:
        print(f"  [{src.kind:5}] {src.name:34} {src.pack}")

    if resolution.rejected:
        print(f"\nnot emitted ({len(resolution.rejected)}):")
        for rej in sorted(resolution.rejected, key=lambda r: (r.gate, r.name)):
            print(f"  [{rej.gate:9}] {rej.name:34} {rej.reason}")
    return 0


def cmd_workflow(args: argparse.Namespace) -> int:
    """Show how a workflow resolves here, and which phases cannot run yet."""
    from workflows import load_workflow, resolve_profile, validate_impls

    project_dir = Path(args.project_dir).resolve()
    path = REPO_ROOT / "workflows" / args.workflow / "workflow.yaml"
    workflow = load_workflow(path)

    profile = resolve_profile(workflow, args.effort, provider=args.provider)
    print(profile.describe())

    packs, _ = _load(project_dir)
    available = {p.name: {s.name for s in p.skills()} for p in packs}
    missing = validate_impls(workflow, available)
    if missing:
        print(f"\n{len(missing)} phase(s) cannot run yet:")
        for m in missing:
            print(f"  {m.phase_id:<14} {m.impl:<45} {m.reason}")
    return 0


def cmd_bootstrap(args: argparse.Namespace) -> int:
    """Materialise the runtimes that gated skills are waiting on.

    Some packs are wrappers around a runtime that is too large to commit and is
    generated by its own installer — BMAD is the case this exists for. Until
    that runtime is on disk, `requires` keeps those skills out of the build, so
    the command palette shows nothing broken. This puts it there.
    """
    import subprocess

    project_dir = Path(args.project_dir).resolve()
    packs, _ = _load(project_dir)
    wanted = [p for p in packs if p.bootstrap.get("command")]
    if args.pack:
        wanted = [p for p in wanted if p.name == args.pack]
        if not wanted:
            print(
                f"skills-cli: no pack named {args.pack!r} declares a bootstrap",
                file=sys.stderr,
            )
            return 1
    if not wanted:
        print("skills-cli: no pack needs bootstrapping.")
        return 0

    failed = False
    for pack in wanted:
        command = [str(c) for c in pack.bootstrap["command"]]
        produces = pack.bootstrap.get("produces")
        if produces and (project_dir / produces).exists() and not args.force:
            print(
                f"{pack.name}: {produces} already present — skipping (--force to redo)"
            )
            continue

        print(f"{pack.name}: running {' '.join(command)}")
        print(f"  in {project_dir}")
        if args.dry_run:
            print("  (dry run — nothing executed)")
            continue
        try:
            subprocess.run(command, cwd=project_dir, check=True)
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            print(f"{pack.name}: bootstrap failed — {exc}", file=sys.stderr)
            failed = True
            continue
        if produces and not (project_dir / produces).exists():
            print(
                f"{pack.name}: installer finished but {produces} is still missing",
                file=sys.stderr,
            )
            failed = True

    if not failed and not args.dry_run:
        print("\nRun `pnpm run skills:build` to emit the skills this unlocked.")
    return 1 if failed else 0


def cmd_why(args: argparse.Namespace) -> int:
    project_dir = Path(args.project_dir).resolve()
    packs, config = _load(project_dir)
    resolution = resolve(packs, config)

    name = args.skill
    if src := resolution.by_name().get(name):
        print(f"{name}: emitted (pack {src.pack}, targets {src.targets or 'any'})")
        return 0

    rejections = resolution.rejections_for(name)
    if not rejections:
        print(f"{name}: no such skill in any pack under {SKILLS_ROOT}", file=sys.stderr)
        return 1
    for rej in rejections:
        print(f"{name}: rejected at gate '{rej.gate}' — {rej.reason}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="skills-cli", description=__doc__)
    parser.add_argument(
        "--project-dir",
        default=str(REPO_ROOT),
        help="project whose targets and pins drive resolution (default: this repo)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser(
        "build", help="materialise skills into the harness outputs"
    )
    p_build.add_argument(
        "--check", action="store_true", help="report drift, write nothing"
    )
    p_build.add_argument(
        "--harness",
        help="comma-separated harness names (default: those marked default)",
    )
    p_build.set_defaults(func=cmd_build)

    p_list = sub.add_parser(
        "list", help="show what resolves, and why the rest does not"
    )
    p_list.set_defaults(func=cmd_list)

    p_boot = sub.add_parser(
        "bootstrap", help="install the runtimes that gated skills are waiting on"
    )
    p_boot.add_argument("--pack", help="bootstrap only this pack")
    p_boot.add_argument("--force", action="store_true", help="re-run even if present")
    p_boot.add_argument("--dry-run", action="store_true", help="print, do not execute")
    p_boot.set_defaults(func=cmd_bootstrap)

    p_wf = sub.add_parser("workflow", help="show how a workflow resolves here")
    p_wf.add_argument("workflow", nargs="?", default="feature-build")
    p_wf.add_argument(
        "--effort", default="medium", help="none|low|medium|high|ultrathink"
    )
    p_wf.add_argument("--provider", help="resolve dispatch against this provider")
    p_wf.set_defaults(func=cmd_workflow)

    p_why = sub.add_parser("why", help="explain one skill's fate")
    p_why.add_argument("skill")
    p_why.set_defaults(func=cmd_why)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (PackError, ValueError, FileNotFoundError, WorkflowError) as exc:
        print(f"skills-cli: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

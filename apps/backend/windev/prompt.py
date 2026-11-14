"""The section every agent phase gets when the project is a WinDev-family one.

Same contract as `mobile.prompt.mobile_section`: one public function, cheap
when it does not apply, read by the planner, every coding subtask, the QA
reviewer and the workflow's skill phases.

What goes in is what a model gets wrong on these projects:

* **what it cannot write** — a window, a control, a report, a new element, the
  analysis, a query: those live in base64 blobs and binary files only the
  editor produces. A model left to itself invents them, and the editor then
  refuses to open the project;
* **how to edit the code it can write** — inside ``code : |1+`` blocks, one
  space deeper than the key, never touching the lines around them;
* **what nobody here can verify** — compiling and running the automated tests
  needs the WinDev editor and its licence, so "compiles" is never claimed.

The language itself (WLangage, H functions, the editor's conventions) and the
format in detail are the bundled `wlangage` and `windev-text-format` skills,
staged next to the spec and named here rather than pasted into every
subtask's prompt.
"""

from __future__ import annotations

from pathlib import Path

from .project import WinDevProject, detect_project
from .skills import stage_skills

__all__ = ["windev_section"]

_PRODUCTS = {
    "windev": "WinDev (Windows application)",
    "webdev": "WebDev (web site)",
    "windev-mobile": "WinDev Mobile (Android / iOS application)",
}

_NATIVE = (
    "**Every element of this project is saved in the native binary format.** "
    "No WLangage code can be read or written outside the WinDev editor. Do not "
    "guess or invent code: report the task as blocked and say that the project "
    'must first be switched to the text format in the editor ("Description du '
    'projet" > "Options" > "Format de sauvegarde des éléments"), WinDev 25 or later.'
)

_EDIT_RULES = (
    "Edit WLangage **only inside `code : |1+` / `code : |1-` blocks**. Every "
    "content line is indented exactly one space deeper than the `code` key "
    "(tabs inside the code are fine); a line indented less ends the block and "
    "breaks the file.",
    "Never write, copy, move or delete an `internal_properties`, `identifier` "
    "or `procedure_id` line, nor the `info` block. They are produced by the "
    "editor; a changed one makes the element unreadable.",
    "Never modify, create or delete a binary WinDev file (native elements, "
    "`.wda`/`.wdd` analysis, `.wdr` queries, `.wxt` test scenarios, HFSQL "
    "`.fic`/`.ndx`/`.mmo` data).",
    "Never create an element file (window, class, procedure set, report, page): "
    "the editor registers each element in the `.wdp` with properties no agent "
    "can produce.",
    "A new procedure may be added to an existing procedure set or class as a new "
    "`procedures` entry (`name`, a new unique numeric `procedure_id`, "
    "`type_code`, `code`, `type`) copied from a sibling of the same kind; say in "
    "the report that it must be reloaded in the editor once.",
)

_ROLE_RULES = {
    "planner": (
        "Plan against these limits. Anything the editor must do (a new window, "
        "control, report, element, analysis file or query; a change to an "
        "existing control's properties) is a subtask titled `À faire dans "
        "l'éditeur WinDev :` with the exact steps, for the person, never for an "
        "agent. The code those elements run (their events, procedures) is a "
        "separate subtask an agent can do once they exist.",
        "No subtask can be verified by compiling or running the WinDev tests "
        "here: each one says how a person checks it in the editor (recompile, "
        "test mode, automated test).",
    ),
    "coder": (
        "If the subtask needs something only the editor can produce, do the "
        "code part only and list what is left for the person in your summary, "
        "under `À faire dans l'éditeur WinDev`.",
        "You cannot compile: re-read every block you changed for unbalanced "
        "`SI … FIN` (a one-line `SI … ALORS instruction` has none), `POUR … FIN`, "
        "`TANTQUE … FIN`, `SELON … FIN`, `BOUCLE … FIN` and `QUAND EXCEPTION "
        "DANS … FIN`, and call only procedures, controls and files that exist "
        "in the project.",
    ),
    "qa": (
        "WorkPilot checks the format mechanically (the WinDev integrity gate): "
        "judge the WLangage itself — logic, H function error handling "
        "(`HErreur`, `HTrouve`), SQL built by concatenation in "
        "`HExécuteRequêteSQL`, secrets in code.",
        "Compilation and automated tests are not verifiable here unless the "
        "project declares a command in `.workpilot/worktree.toml` `[proofs]`: "
        "report them as not verified, never as passed, and never reject a task "
        "only because they could not run.",
    ),
}


def _describe(project: WinDevProject) -> list[str]:
    products = ", ".join(_PRODUCTS.get(p, p) for p in project.products)
    version = (
        f", saved by version {project.major_version}" if project.major_version else ""
    )
    rel = project.project_file.name
    lines = [
        "## WinDev project",
        "",
        f"This project is **{products}**: `{rel}`{version}.",
    ]
    text = project.elements.get("text", 0)
    native = project.elements.get("native", 0)
    if text and native:
        lines.append(
            f"{text} element file(s) are in the text format (readable), {native} are "
            "binary (analysis, queries, tests, or elements still in the native "
            "format): only the text ones can be read or changed."
        )
    return lines


def _display(path: Path, project_dir: Path | str) -> str:
    """``path`` relative to the project when it is inside it."""
    try:
        return "./" + path.resolve().relative_to(Path(project_dir).resolve()).as_posix()
    except (OSError, ValueError):
        return path.as_posix()


def windev_section(
    project_dir: Path | str | None,
    spec_dir: Path | str | None = None,
    *,
    role: str = "coder",
) -> str:
    """The WinDev prompt section, or "" for a project that is not one. Never raises.

    With ``spec_dir``, the WinDev skills are staged there and named by path.
    """
    try:
        project = detect_project(project_dir)
    except (OSError, ValueError):
        return ""
    if project is None:
        return ""
    lines = _describe(project)
    lines.append("")
    if not project.readable:
        lines.append(_NATIVE)
        return "\n".join(lines)
    lines += ["### What an agent can and cannot write", ""]
    lines += [f"- {rule}" for rule in _EDIT_RULES]
    lines += [""]
    lines += [f"- {rule}" for rule in _ROLE_RULES.get(role, _ROLE_RULES["coder"])]
    staged = stage_skills(spec_dir) if project_dir else []
    if staged:
        lines += ["", "The language and the format in detail (staged for this task):"]
        lines += [f"- `{_display(path, project_dir)}`" for path in staged]
    return "\n".join(lines)

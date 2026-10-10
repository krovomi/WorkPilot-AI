"""Phase-default subagents: one definition per role, rosters by name.

These are the generic roster: what every task of a given phase gets before any
language specialisation. `agents/kanban_subagents.py`,
`agents/planner_subagents.py` and `agents/qa_subagents.py` once held them; lot
L11 folded the roles that answered the same question into one definition each
(`SPECS`) and turned every roster into a list of names (`ROSTERS`).

Selection by phase is deliberate — the planner should not carry QA subagents
into its context, and vice versa.

Declared as `AgentSpec`, converted on demand
--------------------------------------------
The rosters used to be built as `AgentDefinition`s directly, which tied them to
the Claude SDK being importable and made them unreadable to anything else. They
are plain data now, and `phase_defaults()` converts them at the point of use.

That is what lets `skills-cli build` emit the same roster into `.github/agents/`
and `.codex/agents/`: one source, N outputs, the same rule the skills follow.
A developer driving Copilot directly gets the specialists the pipeline uses
instead of a different set nobody maintains.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Imported lazily so this module can be imported in test environments where
# claude_agent_sdk is not installed.
try:
    from claude_agent_sdk import AgentDefinition

    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    AgentDefinition = None  # type: ignore[assignment,misc]
    _SDK_AVAILABLE = False

__all__ = [
    "AgentSpec",
    "ROSTERS",
    "SPECS",
    "sdk_available",
    "phase_defaults",
    "phase_specs",
    "all_specs",
    "PHASE_ALIASES",
]


@dataclass(frozen=True)
class AgentSpec:
    """One subagent, as data.

    Field names match `AgentDefinition`'s on purpose: converting is a splat,
    and a reader comparing the two does not have to translate.
    """

    description: str
    prompt: str
    tools: list[str] = field(default_factory=list)
    model: str | None = None

    def to_definition(self) -> Any:
        """The SDK object. Caller must have checked `sdk_available()`."""
        kwargs: dict[str, Any] = {
            "description": self.description,
            "prompt": self.prompt,
            "tools": list(self.tools),
        }
        if self.model:
            kwargs["model"] = self.model
        return AgentDefinition(**kwargs)


# agent_type -> phase. Every AGENT_CONFIGS entry but `coder` is listed — the
# ordinary board card, which "kanban" was built for and which an unlisted
# agent_type still falls through to. `test_subagents_coverage` holds the rule.
#
# The table used to hold five entries, so twenty-one of the twenty-five
# agent_types in the product landed on "kanban" — an `ideation` run was offered
# a test-runner, and a `commit_message` run was offered three specialists to
# write one line. The roster is context the parent pays for on every turn, so a
# mismatched roster is not merely unhelpful, it is billed.
PHASE_ALIASES: dict[str, str] = {
    # Judging finished work against acceptance criteria.
    "qa_reviewer": "qa",
    "qa_fixer": "qa",
    # Running the app the task changed and judging what it shows.
    "verifier": "qa",
    "qa": "qa",
    # Deciding what to do before anything is written. `impact_analyzer` belongs
    # here rather than in "review": its question is blast radius, which is what
    # `dependency-tracer` answers.
    "planner": "planner",
    "architect": "planner",
    "impact_analyzer": "planner",
    # Reading code someone else wrote in order to judge it. Distinct from "qa",
    # which checks a diff against a spec — these have no spec to check against.
    "pr_reviewer": "review",
    "architecture_reviewer": "review",
    "pr_finding_validator": "review",
    # The PR orchestrators bring their own specialists (`pr_review.py`, the
    # follow-up's four). Falling through to "kanban" stacked a code-reviewer,
    # a test-runner and a spec-explorer on top of them: nine and seven
    # entries, three of them answering what a specialist already answers.
    "pr_orchestrator_parallel": "solo",
    "pr_followup_parallel": "solo",
    # Surveying a codebase to produce findings rather than a verdict. The
    # generic `code-reviewer` is the wrong tool here: nothing is under review.
    "ideation": "research",
    "insights": "research",
    "insight_extractor": "research",
    "analyzer": "research",
    "context_mesh_analyzer": "research",
    "learning_analyzer": "research",
    "live_companion_analyzer": "research",
    # The roadmap reads a project to decide what to build next: research, not a
    # build card. It ran as `coder` until the executor named its agent_type.
    "roadmap_discovery": "research",
    "competitor_analysis": "research",
    # Issue analysis and batching. They run through `create_simple_client`,
    # which composes no roster today; the entry says which one they want the
    # day they move to `create_client`.
    "analysis": "research",
    "batch_analysis": "research",
    "batch_validation": "research",
    # Writing or questioning the spec, while there is still no code to point at.
    "spec_writer": "spec",
    "spec_gatherer": "spec",
    "spec_critic": "spec",
    # The two spec prompts that run under their own config
    # (spec/pipeline/agent_runner.py); they ran under `spec_writer` before and
    # keep the roster they had.
    "spec_researcher": "spec",
    "spec_self_critique": "spec",
    # Reading a spec and a plan against each other. Unmapped, this fell through
    # to "kanban" and was handed a `test-runner` by a phase that runs before a
    # line of code exists. A workflow phase that wants another roster says so
    # with `roster:` — see `phase_specs`.
    "spec_validation": "spec",
    # Single-purpose calls that will never delegate. An empty roster is the
    # honest answer; handing them three specialists is context billed per turn
    # and spent on nothing.
    "commit_message": "solo",
    "pr_template_filler": "solo",
    "spec_compaction": "solo",
    "merge_resolver": "solo",
    # One snippet in, one rewritten snippet out (migration/llm_transformer.py).
    "migration": "solo",
    # The one-shot features that built their own SDK options until lot L16:
    # one request in the prompt, one answer out as text, no tool.
    "voice_command": "solo",
    "git_command": "solo",
    "code_playground": "solo",
    "linear_updater": "solo",
    "pr_followup_reviewer": "solo",
    # Writes one archify model from evidence already in its prompt; Python
    # validates and renders it. Unmapped, every authoring round — the
    # Architecture page's and the `architecture-map` phase's — was handed a
    # code-reviewer and a test-runner it has no use for.
    "architecture_visualizer": "solo",
}


def sdk_available() -> bool:
    return _SDK_AVAILABLE and AgentDefinition is not None


#: Every phase subagent, declared once, by name. A roster is a list of these
#: names (`ROSTERS`), so one role serving two phases is one definition: until
#: lot L11 the board's `test-runner` and the QA's `qa-test-evidence` were the
#: same job under two prompts, and `spec-explorer`, `codebase-surveyor` and
#: `architecture-analyst` three wordings of "map this area and report its
#: structure".
SPECS: dict[str, AgentSpec] = {
    "code-reviewer": AgentSpec(
        description=(
            "Read-only code quality and security reviewer. Use for diff "
            "reviews, PR audits, or any 'check this code before I commit' "
            "task. Cannot modify files."
        ),
        prompt=(
            "You are a senior code reviewer focused on quality, security, "
            "and maintainability.\n\n"
            "When reviewing code:\n"
            "- Flag security issues (injection, auth, secrets) first\n"
            "- Then correctness bugs, then maintainability concerns\n"
            "- Quote the exact file path and line number for each finding\n"
            "- Be specific — 'rename this variable' beats 'improve naming'\n"
            "- Skip cosmetic nits unless they hurt readability\n\n"
            "Return a structured summary the parent can act on, not prose."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "test-runner": AgentSpec(
        description=(
            "Runs the project's test suite and returns a condensed pass/fail "
            "report with actionable detail. Use when a card or a QA pass needs "
            "test execution or coverage evidence, without loading megabytes of "
            "test output into the parent."
        ),
        prompt=(
            "You are a test execution specialist. Your job:\n"
            "1. Detect the test framework (pytest, vitest, jest, ...)\n"
            "2. Run the appropriate command\n"
            "3. Parse the output: total / passed / failed / skipped counts, then for each "
            "failure the test name, the expected vs actual values, and the "
            "file:line of the assertion\n"
            "4. Do NOT attempt fixes. Just report — Bash is for execution only.\n\n"
            "If the test command takes more than a few minutes, run it in "
            "the background and report partial results."
        ),
        tools=["Bash", "Read", "Grep", "Glob"],
    ),
    "architecture-analyst": AgentSpec(
        description=(
            "Read-only surveyor. Maps an unfamiliar area of the codebase — or a "
            "spec/ or documentation tree — and returns its structure: module "
            "boundaries, entry points, conventions. Use to orient before "
            "planning, building or forming any opinion."
        ),
        prompt=(
            "You map an area of a codebase, or a spec/documentation tree, and "
            "return its structure.\n\n"
            "Given a topic, a directory or a spec folder:\n"
            "1. Locate the relevant files with Glob and Grep.\n"
            "2. Report the entry points, the main types and shared utilities, "
            "and how data moves between them. For a spec or documentation "
            "tree, list every file with its purpose in one line.\n"
            "3. Name the conventions in use and any place that departs from "
            "them. Flag inconsistencies (a requirement the implementation plan "
            "does not cover) and surface TODO, FIXME and open-question "
            "markers.\n\n"
            "Return structure, not judgement — the parent forms the opinion. "
            "At most ~400 words. Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "dependency-tracer": AgentSpec(
        description=(
            "Traces how a function, class or file is used across the "
            "codebase. Use when the planner needs blast-radius "
            "information for a refactor."
        ),
        prompt=(
            "You are a dependency tracer.\n\n"
            "Given a target symbol or file path:\n"
            "1. Grep for direct and indirect references.\n"
            "2. Group call sites by module / feature area.\n"
            "3. Flag obviously hot code paths (called from many places, "
            "called from tests, called from public API surfaces).\n\n"
            "Return a structured list. Never edit anything."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "qa-acceptance-checker": AgentSpec(
        description=(
            "Read-only acceptance criteria auditor. Use during qa_reviewer "
            "to verify each acceptance bullet against the diff without "
            "polluting the main agent's context."
        ),
        prompt=(
            "You are a QA acceptance auditor.\n\n"
            "Steps:\n"
            "1. Read implementation_plan.json to extract `final_acceptance` bullets.\n"
            "2. For each bullet, grep / read the diff to find evidence.\n"
            "3. Report a structured summary: which bullets are met, which "
            "are missing evidence, which have ambiguous evidence.\n\n"
            "Quote file:line for every claim. Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "security-auditor": AgentSpec(
        description=(
            "Read-only security reader. Use when a change touches auth, "
            "user input, database queries, file paths, deserialisation, "
            "or anything reaching the network."
        ),
        prompt=(
            "You audit a diff for security defects, and nothing else.\n\n"
            "Look for: injection (SQL, command, path, template), broken "
            "authentication or authorisation, secrets committed in the "
            "clear, unsafe deserialisation, and sensitive data reaching "
            "logs.\n\n"
            "For each finding give file:line, the input that reaches the "
            "sink, and what an attacker gets. If you cannot name the "
            "attacker's gain, it is not a finding — say so and move on. "
            "Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "regression-hunter": AgentSpec(
        description=(
            "Checks whether a change breaks existing callers. Use when a "
            "shared function, public signature, or data shape was edited."
        ),
        prompt=(
            "You look for breakage the diff causes elsewhere.\n\n"
            "1. Identify every signature, return shape, and exported name "
            "the diff changed.\n"
            "2. Grep for existing call sites of each.\n"
            "3. Report the ones the change breaks, with file:line, and say "
            "how they break.\n\n"
            "A call site you checked and found safe is worth one line. "
            "Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "test-coverage-auditor": AgentSpec(
        description=(
            "Reports whether the behaviour a diff introduces is actually "
            "tested. Use on any change claiming to be complete."
        ),
        prompt=(
            "You judge whether a diff's new behaviour is covered.\n\n"
            "For each behavioural change, find the test that would fail if "
            "the change were reverted. Name it, with file:line. Where no "
            "such test exists, say which behaviour is unguarded.\n\n"
            "A test that touches the code without asserting on the new "
            "behaviour does not count as coverage, and saying so is the "
            "point of this role. Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "evidence-collector": AgentSpec(
        description=(
            "Confirms or refutes one specific claim about the codebase "
            "with file:line evidence. Use before reporting any finding."
        ),
        prompt=(
            "You are given one claim about this codebase. Establish "
            "whether it is true.\n\n"
            "Return: the verdict (confirmed / refuted / no evidence "
            "either way), then the file:line citations that support it. "
            "Quote the lines you rely on.\n\n"
            "'No evidence either way' is a real and useful answer. Do not "
            "reach for it to avoid work, and do not manufacture a verdict "
            "to avoid it. Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "prior-art-finder": AgentSpec(
        description=(
            "Finds existing implementations of what a spec proposes. Use "
            "before specifying anything that sounds like it might already "
            "exist."
        ),
        prompt=(
            "You search for prior art inside this repository.\n\n"
            "Given a proposed feature, find any existing code that already "
            "does it, partially does it, or once did it and was removed. "
            "Search names, comments, tests and deleted-but-referenced "
            "symbols.\n\n"
            "Report each hit with file:line and one line on how close it "
            "is. 'Nothing found' after a real search is a useful answer. "
            "Never modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
    "constraint-collector": AgentSpec(
        description=(
            "Gathers the conventions and constraints a spec must respect. "
            "Use before writing acceptance criteria."
        ),
        prompt=(
            "You collect the rules a proposed change has to live "
            "within.\n\n"
            "Read AGENTS.md, CLAUDE.md, contributing guides, lint and "
            "type configuration, and the code nearest the change. Report "
            "the constraints that actually bind this change: required "
            "abstractions, forbidden calls, naming and layout rules, test "
            "obligations.\n\n"
            "Cite file:line for each. Leave out rules that do not apply "
            "here — a list of everything is a list of nothing. Never "
            "modify files."
        ),
        tools=["Read", "Grep", "Glob"],
        model="sonnet",
    ),
}

#: Which specialists each roster carries, by name.
ROSTERS: dict[str, tuple[str, ...]] = {
    # The ordinary board card.
    "kanban": ("code-reviewer", "test-runner", "architecture-analyst"),
    # Selection by phase is deliberate — the planner should not carry QA
    # subagents into its context, and vice versa.
    "planner": ("architecture-analyst", "dependency-tracer"),
    "qa": ("qa-acceptance-checker", "test-runner"),
    # For an agent reading code it did not write, with no spec to check it
    # against. Deliberately not the `kanban` roster: `code-reviewer` there is a
    # generalist that reports everything it notices. A review pass wants the
    # opposite — narrow readers that each answer one question well, so the
    # parent can weigh three specific verdicts instead of re-reading one broad
    # essay.
    "review": ("security-auditor", "regression-hunter", "test-coverage-auditor"),
    # For an agent surveying a codebase to produce findings, not a verdict.
    # Ideation, insights and the analyzers share a shape: a broad question, a
    # large search space, and an answer that is only useful if it is grounded
    # in real file:line evidence rather than plausible-sounding generalities.
    "research": ("architecture-analyst", "evidence-collector"),
    # For the spec pipeline, which runs before there is a diff to look at. The
    # failure mode a spec agent actually has is not bad prose — it is
    # specifying something the repo already does, or something its
    # conventions forbid.
    "spec": ("prior-art-finder", "constraint-collector"),
    # No roster: agent_types whose whole job is one short completion — a
    # commit message, a PR template, a compaction. There is no subtask to
    # delegate, so the only thing a roster would add is tokens on every turn.
    "solo": (),
}


def _roster(name: str) -> dict[str, AgentSpec]:
    return {agent: SPECS[agent] for agent in ROSTERS[name]}


def phase_specs(agent_type: str, roster: str | None = None) -> dict[str, AgentSpec]:
    """The generic roster for ``agent_type``, as data.

    Available with or without the SDK, which is what the build needs: emitting
    `.github/agents/` must not depend on a Python package the harness in
    question has nothing to do with.

    ``roster`` names one of `ROSTERS` directly, for a caller that knows better
    than the alias table. A workflow phase is that caller: `analyze` runs under
    the read-only `spec_validation` config — it must not write — but reads a
    plan before any code exists, which is the planner's question rather than
    QA's, and the alias table has one key per agent_type and so cannot answer
    a second phase under the same config differently. An unknown name falls back
    rather than raising: a typo in a workflow file should cost the right roster,
    not the build.
    """
    if roster and roster in ROSTERS:
        return _roster(roster)
    if roster:
        logger.warning(
            "unknown subagent roster %r; falling back to the default for %s",
            roster,
            agent_type,
        )
    return _roster(PHASE_ALIASES.get(agent_type, "kanban"))


def all_specs() -> dict[str, dict[str, AgentSpec]]:
    """Every phase roster, keyed by phase. For the build, not for a run."""
    return {phase: _roster(phase) for phase in ROSTERS}


def phase_defaults(agent_type: str, roster: str | None = None) -> dict[str, Any]:
    """The generic roster for ``agent_type``. Empty when the SDK is absent."""
    if not sdk_available():
        return {}
    return {
        name: spec.to_definition()
        for name, spec in phase_specs(agent_type, roster).items()
    }

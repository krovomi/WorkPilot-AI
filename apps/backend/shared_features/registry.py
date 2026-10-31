"""What a shared feature is: its files on the clone, and the job that writes them.

A feature is declared here, once, and the routes of ``shared_features.api``
serve it. The declaration is the whole contract with a client: which files
it may read (each under a size), which it may rewrite, which runner a job
starts and which options it takes. Nothing a client sends names a path, a
runner or a raw argument.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field

#: A model name as the app's model pickers give it ("sonnet", a full model
#: id, ``provider/model``): never a leading dash, which argparse would read as
#: an option.
MODEL_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,119}$"
ThinkingLevel = Literal["none", "low", "medium", "high", "ultrathink"]


class JobOptions(BaseModel):
    """Options every job takes; a feature adds its own."""

    model_config = ConfigDict(extra="forbid")

    model: str | None = Field(default=None, pattern=MODEL_PATTERN)
    thinking_level: ThinkingLevel | None = None

    def common_args(self) -> list[str]:
        args: list[str] = []
        if self.model:
            args += ["--model", self.model]
        if self.thinking_level:
            args += ["--thinking-level", self.thinking_level]
        return args


@dataclass(frozen=True)
class Feature:
    key: str
    #: Where its files live, relative to the clone.
    directory: str
    #: The files a member may read, with the most of each that is served.
    files: Mapping[str, int]
    #: The files a member may rewrite, each a JSON object.
    writable: frozenset[str]
    #: The runner a job starts (a file of ``runners/``) and its options.
    runner: str
    options: type[JobOptions]
    #: The runner's arguments after ``--project <clone>``, from the options.
    args: Callable[[Any], list[str]]


class RoadmapOptions(JobOptions):
    refresh: bool = False
    competitor_analysis: bool = False
    refresh_competitor_analysis: bool = False


def _roadmap_args(options: RoadmapOptions) -> list[str]:
    args = options.common_args()
    if options.refresh:
        args.append("--refresh")
    if options.competitor_analysis:
        args.append("--competitor-analysis")
    if options.refresh_competitor_analysis:
        args.append("--refresh-competitor-analysis")
    return args


ROADMAP = Feature(
    key="roadmap",
    directory=".workpilot/roadmap",
    files={
        "roadmap.json": 2_000_000,
        "competitor_analysis.json": 1_000_000,
        "roadmap_discovery.json": 500_000,
    },
    writable=frozenset({"roadmap.json"}),
    runner="roadmap_runner.py",
    options=RoadmapOptions,
    args=_roadmap_args,
)

#: The ideation runner's types (``ideation.generator.IDEATION_TYPES``,
#: checked equal by the tests): a job runs a subset of them.
IdeationType = Literal[
    "code_improvements",
    "ui_ux_improvements",
    "documentation_gaps",
    "security_hardening",
    "performance_optimizations",
    "code_quality",
]
IDEATION_TYPES: tuple[str, ...] = get_args(IdeationType)


class IdeationOptions(JobOptions):
    types: list[IdeationType] = Field(default_factory=list, max_length=6)
    include_roadmap_context: bool = True
    include_kanban_context: bool = True
    max_ideas_per_type: int | None = Field(default=None, ge=1, le=50)
    refresh: bool = False
    append: bool = False


def _ideation_args(options: IdeationOptions) -> list[str]:
    args = options.common_args()
    if options.types:
        args += ["--types", ",".join(dict.fromkeys(options.types))]
    if not options.include_roadmap_context:
        args.append("--no-roadmap")
    if not options.include_kanban_context:
        args.append("--no-kanban")
    if options.max_ideas_per_type:
        args += ["--max-ideas", str(options.max_ideas_per_type)]
    if options.refresh:
        args.append("--refresh")
    if options.append:
        args.append("--append")
    return args


IDEATION = Feature(
    key="ideation",
    directory=".workpilot/ideation",
    files={
        "ideation.json": 2_000_000,
        # Written type by type while a job runs; the app reads each as it lands.
        **{f"{kind}_ideas.json": 1_000_000 for kind in IDEATION_TYPES},
    },
    writable=frozenset({"ideation.json"}),
    runner="ideation_runner.py",
    options=IdeationOptions,
    args=_ideation_args,
)

FEATURES: dict[str, Feature] = {f.key: f for f in (ROADMAP, IDEATION)}

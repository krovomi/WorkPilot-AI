"""The closed model of a changelog request, as the server accepts it.

The desktop view's request (``ChangelogGenerationRequest``), each field with
its bounds. A git reference never starts with a dash and never holds ``..``,
so nothing a member types becomes an option of ``git`` or a second range; a
card is named by its id, as the board names it.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

#: As the board names a card (``board_mcp.server.CARD_ID``).
CARD_ID = r"^\d{3,4}-[a-z0-9][a-z0-9-]{0,80}$"
#: A branch or a tag: never an option, never a range, never a path upward.
GIT_REF = r"^(?!.*\.\.)(?!.*//)[A-Za-z0-9_][A-Za-z0-9._/@+-]{0,199}$"
#: The most cards and commits one changelog is built from.
MAX_CARDS = 200
MAX_COMMITS = 1000
MAX_INSTRUCTIONS = 2000
_CARD = re.compile(CARD_ID)

SourceMode = Literal["tasks", "git-history", "branch-diff"]
Format = Literal["keep-a-changelog", "simple-list", "github-release"]
Audience = Literal["technical", "user-facing", "marketing"]
EmojiLevel = Literal["none", "little", "medium", "high"]


class _Closed(BaseModel):
    # The references' pattern looks ahead, which only Python's engine reads.
    model_config = ConfigDict(extra="forbid", regex_engine="python-re")


class GitHistory(_Closed):
    type: Literal["recent", "since-date", "tag-range", "since-version"] = "recent"
    count: int = Field(default=25, ge=1, le=MAX_COMMITS)
    since_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    from_tag: str | None = Field(default=None, pattern=GIT_REF)
    to_tag: str | None = Field(default=None, pattern=GIT_REF)
    include_merge_commits: bool = False


class BranchDiff(_Closed):
    base_branch: str = Field(pattern=GIT_REF)
    compare_branch: str = Field(pattern=GIT_REF)

    @model_validator(mode="after")
    def _two_branches(self) -> BranchDiff:
        if self.base_branch == self.compare_branch:
            raise ValueError("Compare two different branches")
        return self


class ChangelogOptions(_Closed):
    source_mode: SourceMode = "tasks"
    task_ids: list[str] = Field(default_factory=list, max_length=MAX_CARDS)
    git_history: GitHistory | None = None
    branch_diff: BranchDiff | None = None
    version: str = Field(default="1.0.0", pattern=r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$")
    date: str = Field(default="1970-01-01", pattern=r"^\d{4}-\d{2}-\d{2}$")
    format: Format = "keep-a-changelog"
    audience: Audience = "technical"
    emoji_level: EmojiLevel = "none"
    custom_instructions: str = Field(default="", max_length=MAX_INSTRUCTIONS)

    @model_validator(mode="after")
    def _source_given(self) -> ChangelogOptions:
        if any(not _CARD.match(task) for task in self.task_ids):
            raise ValueError("Not a card id")
        if self.source_mode == "tasks" and not self.task_ids:
            raise ValueError("Choose at least one card")
        if self.source_mode == "git-history" and self.git_history is None:
            raise ValueError("Say which commits")
        if self.source_mode == "branch-diff" and self.branch_diff is None:
            raise ValueError("Say which branches")
        return self

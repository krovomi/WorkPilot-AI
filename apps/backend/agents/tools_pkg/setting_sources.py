"""Which settings files a Claude session loads, decided per agent type.

The SDK's `setting_sources` decides what Claude Code reads from disk on top of
the options WorkPilot passes: "project" (the project's `.claude/`, CLAUDE.md,
skills and hooks), "user" (the person's ~/.claude: their own CLAUDE.md, skills
and hooks) and "local" (`.claude/settings.local.json`). Each type declares its
sources in `AGENT_CONFIGS`; this module turns the declaration and two
environment variables into the list both factories pass
(`core.client.create_client`, `core.simple_client.create_simple_client`).

Precedence, highest first:

1. ``AUTO_CLAUDE_SETTING_SOURCES`` — a comma list among project, user and
   local, for every type. "project" is always kept: it is how the project's
   CLAUDE.md loads, which the project's own `useClaudeMd` setting governs.
2. ``AUTO_CLAUDE_CODER_USER_SETTINGS`` — false narrows a type that declares
   the user's sources (the coder) to the project.
3. The type's declaration, else the project only.

None of these grants a tool: what a type may call stays its declaration in
`AGENT_CONFIGS["tools"]`, enforced by `disallowed_tools` whatever the user's
settings files allow (`undeclared_builtin_tools`).
"""

from __future__ import annotations

import logging
import os

from .models import AGENT_CONFIGS

logger = logging.getLogger(__name__)

#: The order the SDK documents; the result is always given in it.
KNOWN_SOURCES = ("project", "user", "local")

#: The sources of a type that declares none, or of a type this registry does
#: not know. The project only, because what it adds is shared and reviewed
#: with the code: a session that also read ~/.claude would follow instructions
#: and run hooks nobody else can see, which a reviewer or a planner must not do,
#: and a type added tomorrow has not been through that decision yet.
DEFAULT_SOURCES: tuple[str, ...] = ("project",)

OVERRIDE_ENV = "AUTO_CLAUDE_SETTING_SOURCES"
CODER_USER_SETTINGS_ENV = "AUTO_CLAUDE_CODER_USER_SETTINGS"

_OFF = frozenset({"0", "false", "no", "off"})


def _override() -> list[str] | None:
    raw = os.environ.get(OVERRIDE_ENV, "")
    asked = {part.strip().lower() for part in raw.split(",") if part.strip()}
    if not asked:
        return None
    unknown = sorted(asked - set(KNOWN_SOURCES))
    if unknown:
        logger.warning(
            "%s: ignoring unknown setting source(s) %s", OVERRIDE_ENV, unknown
        )
    asked = (asked & set(KNOWN_SOURCES)) | {"project"}
    return [source for source in KNOWN_SOURCES if source in asked]


def _user_settings_allowed() -> bool:
    value = os.environ.get(CODER_USER_SETTINGS_ENV, "").strip().lower()
    return value not in _OFF


def setting_sources_for(agent_type: str) -> list[str]:
    """The `setting_sources` of one session of `agent_type` (a new list)."""
    if (forced := _override()) is not None:
        return forced
    config = AGENT_CONFIGS.get(agent_type) or {}
    declared = config.get("setting_sources") or DEFAULT_SOURCES
    sources = [source for source in KNOWN_SOURCES if source in declared]
    if not _user_settings_allowed():
        sources = [source for source in sources if source == "project"]
    return sources or list(DEFAULT_SOURCES)

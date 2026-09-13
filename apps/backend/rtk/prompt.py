"""The paragraph an agent needs when its command output has been condensed.

Without it the saving partly undoes itself. A model that asked for `git diff`
and gets forty lines where it expected four hundred does the reasonable thing:
it doubts the result and runs the command again, differently, twice — and two
extra turns cost more than the filtering saved. Telling it up front that the
output is complete-but-condensed, and naming the one escape hatch, is what
turns a smaller payload into a smaller bill.

The wording is adapted from rtk's own `hooks/rtk-awareness.md`, which is the
text upstream tuned for exactly this. It is deliberately short: it is prepended
to every session of every phase, so a paragraph here is paid for thousands of
times and a page here is a cost, not a courtesy.

Byte-stability matters as much as brevity. `build_base_system_prompt` is the
cacheable prefix every provider matches on, so this section must never carry a
version number, a path, a count or a timestamp: a prefix that changes when rtk
is upgraded is a prompt cache that misses on the first build after an upgrade.
"""

from __future__ import annotations

from .runtime import is_usable

__all__ = ["AWARENESS", "awareness_section"]

AWARENESS = """
## Command output

Command output in this session is condensed by rtk, a CLI proxy that filters
noise out of shell output while keeping every signal. A hook rewrites your
commands before they run: behaviour and exit codes are unchanged, only what
you read is shorter. Treat what you get as the complete result — run commands
normally, and batch related commands into one call rather than spending a turn
each. Truncated output states its own recovery path. Re-run something as
`rtk proxy <command>` only when its result is genuinely unusable: empty where
output was clearly expected, contradicting its own exit code, or garbled.
""".strip()


def awareness_section(env: dict | None = None) -> str:
    """The section to append, or an empty string when rtk is not in play.

    Empty is the important half. On a machine without rtk this must add
    nothing at all: an agent told its output is condensed when it is not will
    second-guess perfectly complete results.
    """
    return f"\n\n{AWARENESS}\n" if is_usable(env) else ""

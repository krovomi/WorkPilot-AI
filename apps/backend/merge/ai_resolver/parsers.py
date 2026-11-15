"""
Code Parsers
============

What counts as code in a model's answer.

The answer is written into the project file, so only a fenced block counts:
a model that explains instead of merging, or forgets the fence, sends the
conflict to review rather than putting a sentence in the file. The block's
language tag is never part of the code.
"""

from __future__ import annotations

import re

# An opening fence with any info string (``csharp``, ``c#``, ``objective-c``
# or none), the code, and a closing fence at the start of a line.
_FENCED_BLOCK = re.compile(r"^```([^\n`]*)\n(.*?)^```", re.DOTALL | re.MULTILINE)


def extract_code_block(response: str, language: str) -> str | None:
    """The code of the answer's block in ``language``, else of its first block."""
    blocks = [
        (tag.strip().lower(), code.strip())
        for tag, code in _FENCED_BLOCK.findall(response or "")
    ]
    if not blocks:
        return None
    wanted = language.lower()
    for tag, code in blocks:
        if tag == wanted:
            return code
    return blocks[0][1]

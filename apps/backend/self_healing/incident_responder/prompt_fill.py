"""Fill an incident prompt template in one pass.

Each ``{{NAME}}`` of the template is replaced once, by its value. A value is
never searched for placeholders: a commit message or a log that contains
``{{DIFF}}`` stays that text, it does not pull another field into its place.
"""

from __future__ import annotations

import re

_PLACEHOLDER = re.compile(r"\{\{[A-Z_]+\}\}")


def fill_template(template: str, values: dict[str, str]) -> str:
    """*template* with every known ``{{NAME}}`` replaced; unknown ones are kept."""
    return _PLACEHOLDER.sub(lambda m: values.get(m.group(0), m.group(0)), template)

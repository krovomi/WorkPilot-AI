"""The GitHub CLI folder Copilot's token is read from.

Settings → AI accounts can keep several GitHub sign-ins for Copilot, each in a
GitHub CLI folder of its own; the app passes the default one's folder in
``COPILOT_GH_CONFIG_DIR``. Only the Copilot token lookups use it: the ``gh``
an agent runs for pull requests keeps the person's usual sign-in.
"""

from __future__ import annotations

import os


def copilot_gh_env() -> dict[str, str] | None:
    """The environment for a Copilot ``gh auth`` call, or None to inherit it."""
    folder = os.environ.get("COPILOT_GH_CONFIG_DIR", "").strip()
    if not folder:
        return None
    return {**os.environ, "GH_CONFIG_DIR": folder}

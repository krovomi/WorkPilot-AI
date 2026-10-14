"""Values of a project's ``.workpilot/.env`` that only the desktop app can read.

The desktop app encrypts the tokens it writes to that file with the OS keyring
(Electron ``safeStorage``): a secret is stored ``enc:<base64>``. Python cannot
call the keyring, and it does not need to — when the app spawns the backend it
decrypts those values and passes them as environment variables, which every
reader here lets win over the file.

Without the app (``python run.py``, ``runners/spec_runner.py``), an ``enc:``
value is unusable: it is treated as absent and said once per key, so the user
knows to export the variable. Ciphertext is never handed to an API or an MCP
server as if it were a token. See docs/architecture/secrets-at-rest.md.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping

logger = logging.getLogger(__name__)

APP_ENCRYPTED_PREFIX = "enc:"

_warned: set[str] = set()


def is_app_encrypted(value: object) -> bool:
    """Whether ``value`` is a secret the desktop app encrypted."""
    return isinstance(value, str) and value.startswith(APP_ENCRYPTED_PREFIX)


def usable_file_value(key: str, value: str) -> str | None:
    """``value`` as read from ``.workpilot/.env``, or None when it is encrypted."""
    if not is_app_encrypted(value):
        return value
    if key not in _warned:
        _warned.add(key)
        logger.warning(
            "%s in .workpilot/.env is encrypted by the WorkPilot desktop app and "
            "cannot be read outside it; it is ignored. Export %s in the "
            "environment (or in .env-files/.env) to use it from the CLI.",
            key,
            key,
        )
    return None


def drop_app_encrypted(values: Mapping[str, str]) -> dict[str, str]:
    """A copy of ``values`` without the ones the desktop app encrypted."""
    result: dict[str, str] = {}
    for key, value in values.items():
        usable = usable_file_value(key, value)
        if usable is not None:
            result[key] = usable
    return result


def _reset_warnings_for_tests() -> None:
    _warned.clear()

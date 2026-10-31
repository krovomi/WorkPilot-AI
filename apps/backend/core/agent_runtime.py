"""``core``'s implementation of the ``agent_runtime`` port.

Each call imports its function when it runs, not here: importing ``core``
stays light (see ``core/__init__.py``), and a test that patches
``core.auth.get_auth_token`` or ``core.simple_client.create_simple_client``
reaches the units that go through the port too. ``from core.x import f`` reads
``sys.modules["core.x"]``, the module in use, where ``from core import x``
would read the package attribute, which a test that swaps ``sys.modules``
entries can leave pointing at an older module.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import agent_runtime


class CoreAgentRuntime:
    def get_auth_token(self) -> str | None:
        from core.auth import get_auth_token

        return get_auth_token()

    def require_auth_token(self) -> str:
        from core.auth import require_auth_token

        return require_auth_token()

    def ensure_claude_code_oauth_token(self) -> None:
        from core.auth import ensure_claude_code_oauth_token

        ensure_claude_code_oauth_token()

    def create_simple_client(self, **kwargs: Any) -> Any:
        from core.simple_client import create_simple_client

        return create_simple_client(**kwargs)

    def create_agent_client(self, **kwargs: Any) -> Any:
        from core.client import create_agent_client

        return create_agent_client(**kwargs)

    def create_agent_runtime(self, **kwargs: Any) -> Any:
        from core.runtimes import create_agent_runtime

        return create_agent_runtime(**kwargs)

    async def run_agent_session(
        self, client: Any, message: str, spec_dir: Path, **kwargs: Any
    ) -> tuple[str, str, dict]:
        from agents.session import run_agent_session

        return await run_agent_session(client, message, spec_dir, **kwargs)


agent_runtime.install(CoreAgentRuntime())

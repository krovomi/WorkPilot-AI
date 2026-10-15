"""The context harness: see ``docs/architecture/context-harness.md``.

``harness.domain`` holds the pure decisions and measures, with no provider name
in them; the clients in ``core/agent_clients/`` read their provider's format
into it.
"""

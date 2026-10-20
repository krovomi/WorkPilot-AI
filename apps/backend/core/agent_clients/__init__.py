"""One module per agent-client provider (audit lot L11, F36).

`core/agent_client.py` was 5 500 lines holding every adapter. Each provider
now lives in its own module; `core.agent_client` re-exports every name, so
importers and patch targets naming the class keep working.
"""

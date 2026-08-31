"""Manual check of the Windsurf gRPC flow: InitializeCascadePanelState +
RawGetChatMessage.

This is a diagnostic script, not a test. It talks to a running Windsurf IDE
over gRPC and prints what came back — there is nothing to assert without one.

It was called `test_windsurf_flow.py` and sat in the backend root, so pytest
collected it and `asyncio.run(...)` at module scope ran the whole flow during
*collection*, failing with "Windsurf language server not found" on every
machine that is not running the IDE. Renamed and moved so its name says what
it is, and guarded so importing it does nothing.

Run it with Windsurf open:
    cd apps/backend && python scripts/windsurf_flow_check.py
"""

import asyncio
import sys

sys.path.insert(0, ".")


async def check_windsurf_flow():
    from integrations.windsurf_proxy.auth import discover_credentials
    from integrations.windsurf_proxy.grpc_client import stream_chat
    from integrations.windsurf_proxy.models import resolve_model

    print("=== Windsurf gRPC Flow Test ===\n")

    # Step 1: Discover credentials (CSRF from process env, API key, port)
    print("1. Discovering credentials...")
    creds = discover_credentials()
    print(f"   Port: {creds.port}")
    print(f"   Version: {creds.version}")
    print(f"   CSRF present: {bool(creds.csrf_token)}")
    print(f"   API Key present: {bool(creds.api_key)}")

    # Step 2: Resolve model
    model_name = "claude-4-sonnet"
    model_enum, model_grpc_name = resolve_model(model_name)
    print(f"\n2. Model: {model_name} → enum={model_enum}, grpc_name={model_grpc_name}")

    # Step 3: Send chat via gRPC (Connect protocol)
    # This will: InitializeCascadePanelState → RawGetChatMessage (streaming)
    print("\n3. Sending chat request...")
    messages = [{"role": "user", "content": "Say hello in one word."}]

    text_parts = []
    try:
        async for chunk in stream_chat(
            credentials=creds,
            messages=messages,
            model_enum=model_enum,
            model_name=model_grpc_name,
        ):
            text_parts.append(chunk)
            print(f"   Chunk: {chunk!r}")
    except Exception as e:
        print(f"   Error: {e}")
        return

    full_text = "".join(text_parts)
    print(f"\n4. Full response ({len(full_text)} chars): {full_text[:200]}")

    if full_text:
        print("\n✓ SUCCESS — Windsurf gRPC flow is working!")
    else:
        print("\n✗ FAILED — Empty response from Windsurf")


if __name__ == "__main__":
    asyncio.run(check_windsurf_flow())

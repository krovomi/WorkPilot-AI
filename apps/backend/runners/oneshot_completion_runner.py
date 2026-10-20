#!/usr/bin/env python3
"""
One-Shot Completion Runner — provider-agnostic single text completion.

A thin CLI around ``core.oneshot.oneshot_completion`` used by the frontend's
lightweight utilities (task title, terminal name, spec interview, visual-proof
navigation). It honours whatever LLM provider the user selected — the prompt is
built on the frontend, this just runs it through the active provider.

Input: a JSON file passed via ``--input <path>`` with keys:
    prompt        (str, required)  the complete user prompt
    system_prompt (str, optional)  system prompt
    project_dir   (str, optional)  working directory (enables exotic-provider routing)
    spec_dir      (str, optional)  spec directory (provider/model resolution)
    provider      (str, optional)  override; else resolved from env/task metadata
    model         (str, optional)  override; else a cheap per-provider default
    max_turns     (int, optional)  default 1
    stream        (bool, optional) also emit each chunk as it arrives
    require_provider (bool, optional) refuse rather than run `provider` on
                  another vendor's SDK — for a caller comparing providers

Output: ``__ONESHOT_RESULT__:<raw model text>`` on stdout (exit 0). Any failure
exits non-zero with a short reason on stderr so the caller can degrade.

Two further lines are emitted when the provider gives something to emit, both
JSON-encoded and both optional — a caller that ignores them sees exactly what
it saw before:

``__ONESHOT_USAGE__:{"input_tokens", "output_tokens", "cost_usd"}``
    what the provider itself reported. Absent when it reported nothing, so a
    caller can tell a measurement from a zero it made up.
``__ONESHOT_ERROR__:{"message", "code", "provider", "model", ...}``
    the redacted diagnostic behind a failure. stderr already carries a short
    reason; this carries one a UI can show without risking credential material.

With ``stream`` set, every chunk is additionally printed, as it arrives, on its
own line as ``__ONESHOT_DELTA__:<json-encoded chunk>``. JSON-encoded because a
chunk carries newlines of its own and a caller reading stdout line by line
would otherwise have no way to tell a chunk boundary from a line break inside
one. The final ``__ONESHOT_RESULT__`` line is emitted either way, so a caller
that ignores the deltas sees exactly what it saw before.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Add the backend package root to the path (mirrors the other runners).
sys.path.insert(0, str(Path(__file__).parent.parent))

RESULT_MARKER = "__ONESHOT_RESULT__:"
DELTA_MARKER = "__ONESHOT_DELTA__:"
USAGE_MARKER = "__ONESHOT_USAGE__:"
ERROR_MARKER = "__ONESHOT_ERROR__:"


def _make_delta_emitter():
    """Print each chunk on its own line, flushed, as the model produces it.

    Flushed per chunk on purpose: the point of streaming is that the caller
    sees the text before the process exits, and Python buffers stdout when it
    is a pipe — which is exactly what the caller is reading.
    """

    def emit(chunk: str) -> None:
        if not chunk:
            return
        print(DELTA_MARKER + json.dumps(chunk), flush=True)

    return emit


def _emit_marker(marker: str, payload: dict) -> None:
    """Print one marker line, flushed, ignoring anything unserialisable.

    A diagnostic the caller cannot read is not worth failing the run over: the
    result line is what it is graded on.
    """
    try:
        print(marker + json.dumps(payload, default=str), flush=True)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Provider-agnostic one-shot completion"
    )
    parser.add_argument("--input", required=True, help="Path to the JSON input file")
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"Could not read input: {exc}", file=sys.stderr)
        return 1

    prompt = payload.get("prompt")
    if not prompt:
        print("Missing required 'prompt' field", file=sys.stderr)
        return 1

    on_delta = _make_delta_emitter() if payload.get("stream") else None

    try:
        from core.oneshot import oneshot_completion

        result = asyncio.run(
            oneshot_completion(
                prompt,
                system_prompt=payload.get("system_prompt"),
                provider=payload.get("provider"),
                model=payload.get("model"),
                project_dir=payload.get("project_dir"),
                spec_dir=payload.get("spec_dir"),
                max_turns=int(payload.get("max_turns", 1)),
                require_provider=bool(payload.get("require_provider")),
                on_delta=on_delta,
                on_error=lambda detail: _emit_marker(ERROR_MARKER, detail),
                on_usage=lambda usage: _emit_marker(USAGE_MARKER, usage),
            )
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Generation failed: {exc}", file=sys.stderr)
        return 1

    if not result:
        print("Empty response", file=sys.stderr)
        return 1

    print(RESULT_MARKER + result, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

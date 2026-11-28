"""Board ask runner: the tickets of a board ranked by meaning.

Spawned by the Electron main process (``main/board-ask/semantic-search.ts``)
when someone asks the Kanban board a question: the question and the tickets
go in, their closeness to the question comes out (``board_ask.semantic``).

Input: a JSON file passed via ``--input <path>``::

  {"mode": "auto" | "local" | "off", "cache_dir": "<app folder>",
   "project_dir": "<project>", "query": "...",
   "documents": [{"id": "...", "text": "..."}]}

Output, one line on stdout (exit 0)::

  __BOARD_ASK_SEMANTIC__:{"source": {"kind", "provider", "model"},
                          "scores": [{"id", "score"}], "indexed", "total"}

``"source": null`` when no embeddings model can be asked (none on the machine,
a provider without embeddings, the strict offline policy, ``off``): the panel
then ranks by keywords alone. A malformed input exits 2 with a short reason on
stderr; nothing of the input is echoed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from board_ask.semantic import parse_request, rank, resolve  # noqa: E402

MARKER = "__BOARD_ASK_SEMANTIC__:"
MAX_INPUT_BYTES = 8 * 1024 * 1024


def _emit(payload: dict) -> None:
    print(MARKER + json.dumps(payload, ensure_ascii=False), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    args = parser.parse_args(argv)
    try:
        path = Path(args.input)
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError("input too large")
        request = parse_request(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        print(f"board ask: invalid input ({type(exc).__name__})", file=sys.stderr)
        return 2
    found = resolve(request["mode"], request["cache_dir"], request["project_dir"])
    if found is None:
        _emit({"source": None, "scores": []})
        return 0
    source, embedder = found
    ranking = rank(source, embedder, request["query"], request["documents"])
    _emit(ranking.to_dict() if ranking else {"source": None, "scores": []})
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())

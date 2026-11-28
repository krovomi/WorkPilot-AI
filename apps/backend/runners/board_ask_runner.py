"""« Interroger le tableau » on a server project's clone (``board_ask.answer``).

Started by the server as a project job (``shared_board/ask.py``) for the
phone app: it reads the clone's board, asks the project's provider through
``core.oneshot`` (every provider, single turn, no tool) and prints one line::

    __BOARD_ASK__:{"answer": "...", "matches": [...], "mode": "ai", ...}

Arguments: ``--project-dir`` (the clone, put first by the server),
``--question=<text>``, ``--language=<code>`` (the app's language, for an
answer whose question's own cannot be told) and ``--history-file`` (the
conversation's earlier turns, a file of the job's own folder).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

MARKER = "__BOARD_ASK__:"
LANGUAGE = re.compile(r"^[a-z]{2}$")
MAX_TURNS = 4
TURN_CHARS = 4000


def read_history(path: str | None) -> list[dict[str, str]]:
    """The earlier turns, as bounded strings; [] when there are none."""
    if not path:
        return []
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    turns = []
    for turn in value if isinstance(value, list) else []:
        if (
            isinstance(turn, dict)
            and isinstance(turn.get("question"), str)
            and isinstance(turn.get("answer"), str)
        ):
            turns.append(
                {
                    "question": turn["question"][:TURN_CHARS],
                    "answer": turn["answer"][:TURN_CHARS],
                }
            )
    return turns[-MAX_TURNS:]


def make_complete(project_dir: Path):
    """One completion on the project's provider; "" when it fails."""

    async def complete(prompt: str, system_prompt: str) -> str:
        from core.oneshot import oneshot_completion

        # A provider without credentials (no OAuth token on the server, no
        # key) refuses before answering: the board still answers by its
        # words, as the desktop app does without a model.
        try:
            return await oneshot_completion(
                prompt,
                system_prompt=system_prompt,
                project_dir=str(project_dir),
                max_turns=1,
            )
        except (ImportError, OSError, RuntimeError, TypeError, ValueError) as error:
            print(f"board ask: no answer from the model ({type(error).__name__})")
            return ""

    return complete


async def run(args: argparse.Namespace, complete=None) -> dict:
    from board_ask.answer import ask_board
    from board_ask.tickets import board_tickets

    root = Path(args.project_dir).resolve()
    language = args.language if LANGUAGE.match(args.language or "") else "en"
    return await ask_board(
        board_tickets(root),
        args.question,
        complete or make_complete(root),
        language=language,
        history=read_history(args.history_file),
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--history-file")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    result = asyncio.run(run(parse_args(argv)))
    print(MARKER + json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())

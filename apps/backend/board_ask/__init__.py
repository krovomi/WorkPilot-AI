"""« Interroger le tableau » : the semantic half of a board question.

The Kanban panel (``apps/frontend/src/main/board-ask/``) answers a question
with the tickets that relate to it, whatever language they are written in.
Its keyword search and its model run in the app; this package gives it the
other ranking, by meaning: an embeddings model reads the question and every
ticket, and the tickets closest to the question come first, across languages.

`semantic` holds the whole of it; ``runners/board_ask_embed_runner.py`` is
its entry point. Design: ``docs/architecture/board-ask.md``.
"""

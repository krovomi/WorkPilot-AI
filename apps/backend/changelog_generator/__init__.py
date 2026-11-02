"""The changelog of a project, built from its finished cards or its git history.

The desktop app builds a local project's changelog in its main process
(``apps/frontend/src/main/changelog/``). A server project has no folder on the
computer: its changelog is built on the server, by ``runners/changelog_runner.py``
as a job on the project's clone, and saved as the project's shared report
(``shared_features.analyses``). This package is what that runner and the
server's routes share, with no server import:

- ``options``: the closed model of a request (source, version, format...);
- ``prompts``: the prompts of the desktop generator (``formatter.ts``) and its
  clean-up of the model's answer (``parser.ts``), the same text on both sides;
- ``git_history``: branches, tags and commits of a clone (``git-integration.ts``);
- ``cards``: the done cards of the board in the clone and their specs.

See ``docs/architecture/changelog.md``.
"""

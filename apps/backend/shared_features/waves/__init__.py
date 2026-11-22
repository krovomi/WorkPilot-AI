"""Execution waves of a server project (Conflict Predictor, issue #358).

The desktop app plans the waves of a local project in its main process
(``apps/frontend/src/main/conflict-waves/``). A server project's cards, plans
and build workspaces live in the server's clone, so the same planner runs
here, for the server's routes (``shared_features.execution_waves``) and the
mobile app:

- ``scorer``: a file's weight by its role in the build, a pair's score,
  fragile links;
- ``code_links``: cross imports and removed symbols, read from the code;
- ``planner``: the conflict graph, cycles, greedy colouring, merge order;
- ``git_reads``: what a build workspace changed, its diff and head, the
  history's co-changes, a test merge, the code of a card's files;
- ``merge_check``: the preventive merge check around the planner;
- ``service``: the plan of a project's backlog, from its clone;
- ``run_store``: the run of "Execute in optimal order" and its history, in
  the clone's ``.workpilot``;
- ``execution``: one step of that run, pure.

Static and deterministic: no model is called, whatever the provider, and the
same footprints give the same plan as on the desktop.
"""

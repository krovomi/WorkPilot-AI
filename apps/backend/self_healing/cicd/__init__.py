"""CI/CD regressions traced back to their first bad commit (#375).

``triggers`` says when the last commit is probably not the culprit, ``green``
remembers the last commit seen passing, ``bisect`` runs the failing tests in a
temporary worktree between the two, and ``flow`` hands the result to the
incident and to the fixer's prompt. Deterministic: git and the stack's own
test command, no model.

``flow`` reads the incident models, whose package imports this one: the
incident responder imports these modules, never names re-exported here.
"""

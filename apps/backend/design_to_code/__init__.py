"""Import Design's render loop: render the generated code, compare, correct (#379).

After the pipeline of ``services/design_to_code_service.py`` has generated the
files, the loop renders them headless at the target's size, compares the
capture with the design without a model (``diff``), gives a vision model a
neutral, structured account of what differs (``feedback``), applies the edits it
answers, and starts again until the score reaches the threshold or the budget
runs out (``loop``). ``render`` holds the browser, ``vision`` decides which
model may look at the pictures.

The model call is not made here: the runner hands the loop its ``correct``
callable, built on the service's own vision routes, so this package stays below
the agent runtime (``tests/test_import_contracts.py``).
Design: ``docs/architecture/design-render-loop.md``.
"""

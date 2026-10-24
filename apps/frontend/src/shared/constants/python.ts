/**
 * The oldest Python the backend runs on.
 *
 * The backend uses 3.12 syntax (PEP 701 f-strings, among others) and CI tests
 * 3.12 and 3.13, so an older interpreter fails at import, far from the check.
 * `apps/backend/run.py` and `runners/spec_runner.py` refuse the same floor;
 * `tests/test_python_floor.py` keeps the three in step.
 */
export const MINIMUM_PYTHON_VERSION = "3.12.0";

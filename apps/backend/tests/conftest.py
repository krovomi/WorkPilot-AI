"""Local conftest for the archify integration tests.

Keeps the parent conftest — and its Azure DevOps imports — out of the way, the
same reason `tests/test_architecture/conftest.py` has one.
"""

import sys
from pathlib import Path

backend_path = str(Path(__file__).parent.parent.parent / "apps" / "backend")
if backend_path not in sys.path:
    sys.path.insert(0, backend_path)

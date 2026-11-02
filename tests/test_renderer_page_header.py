"""Views open with the shared ``PageHeader``, not a hand-written ``<h1>``.

Each view used to style its own title: eleven combinations of size and weight
(``text-2xl font-bold``, ``text-lg font-semibold``, ``text-xl``...), with or
without an icon, a band or a description. Moving from one view to the next
changed the type scale. F148 moved them to ``components/ui/page-header.tsx``;
this test keeps new views on it.

The screens left out are not views of the main window: the onboarding wizard
steps, the welcome screen and the Mission Control launch hero are full-screen
layouts with their own large title, and ``PRHeader`` titles one pull request
inside the PR view.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = ROOT / "apps" / "frontend" / "src" / "renderer" / "components"

ALLOWED = {
    "ui/page-header.tsx",
    "WelcomeScreen.tsx",
    "github-prs/components/PRHeader.tsx",
    "mission-control/MissionControlDashboard.tsx",
}
ALLOWED_DIRS = ("onboarding/",)

H1 = re.compile(r"<h1[\s>]")


def test_views_use_the_shared_page_header() -> None:
    offenders = []
    for path in COMPONENTS.rglob("*.tsx"):
        if ".test." in path.name:
            continue
        rel = path.relative_to(COMPONENTS).as_posix()
        if rel in ALLOWED or rel.startswith(ALLOWED_DIRS):
            continue
        text = path.read_text(encoding="utf-8")
        for match in H1.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            offenders.append(f"{rel}:{line}")
    assert not offenders, (
        "Use PageHeader from components/ui/page-header.tsx instead of a "
        "hand-written <h1>:\n" + "\n".join(sorted(offenders))
    )


def test_allowlist_has_no_stale_entries() -> None:
    stale = [
        rel
        for rel in sorted(ALLOWED)
        if not (COMPONENTS / rel).is_file()
        or not H1.search((COMPONENTS / rel).read_text(encoding="utf-8"))
    ]
    assert not stale, f"Remove these from ALLOWED, they have no <h1>: {stale}"

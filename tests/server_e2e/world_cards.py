"""Cards the apps' end-to-end world puts on the "Team App" board before anyone signs in.

``app_world.py`` calls :func:`seed_app_cards` once the server runs. Each card
is created through the board's own route (``POST /api/board/cards``), as
Alice would from the app; what a build would have left next to one of them is
then written in its spec folder of the server's clone, as the pipeline does:

- "Redesign the settings page" prepared the captures of its pull request
  (``pr_captures``) and the team reviews them first (``CAPTURES_PUBLISH=review``):
  one screen whose before and after copies may be published, and one whose
  personal data could not be replaced, held back. The published copies are
  small real PNG images, so the apps draw them;
- the other cards are plain backlog cards, for « Interroger le tableau » to
  find by their words.

The cards' titles go back to the specs in the world's JSON line
(``appCards``), keyed by what each card is for.
"""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

from tests.server_e2e import stack as e2e

CAPTURES_CARD = "Redesign the settings page"
EMAILS_CARD = "Translate the onboarding emails"
INVOICE_CARD = "Fix the invoice rounding"

_DESCRIPTIONS = {
    CAPTURES_CARD: "Group the notification switches and move the danger zone to the end.",
    EMAILS_CARD: "The welcome and onboarding emails exist in English only; write them in French.",
    INVOICE_CARD: "Totals are off by one cent when a discount applies.",
}


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """A solid image in one colour, as a valid PNG file."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\x00" + bytes(rgb) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def _side(file: str, signature: str, *, publishable: bool = True) -> dict:
    return {
        "source": file.replace("published/", ""),
        "file": file if publishable else "",
        "signature": signature,
        "protected": True,
        "privacy": {
            "status": "pseudonymized" if publishable else "withheld",
            "replaced": 2 if publishable else 0,
            "checks": ["page", "ocr:tesseract"],
            "kinds": ["email", "phone"] if publishable else [],
            "notes": [],
        },
        "publishable": publishable,
    }


def publication() -> dict:
    """What `pr_captures.publication` writes for the settings card."""
    return {
        "version": 1,
        "generatedAt": "2026-11-28T16:00:00+00:00",
        "decision": {"needed": True, "reason": "ui-files"},
        "settings": {"publish": "review", "protect": True, "publishUnchecked": False},
        "items": [
            {
                "key": "web|/settings|desktop|en",
                "label": "Settings",
                "platform": "web",
                "variant": "desktop",
                "route": "settings",
                "locale": "en",
                "source": "verify",
                "before": _side("captures/published/base/settings.png", "1:2"),
                "after": _side("captures/published/task/settings.png", "1:3"),
                "publishable": True,
            },
            {
                "key": "web|/profile|desktop|en",
                "label": "Profile",
                "platform": "web",
                "variant": "desktop",
                "route": "profile",
                "locale": "en",
                "source": "verify",
                "before": None,
                "after": _side(
                    "captures/published/task/profile.png", "1:4", publishable=False
                ),
                "publishable": False,
            },
        ],
        "publishable": 1,
        "withheld": 1,
    }


def write_captures(spec: Path) -> None:
    """The captures folder a build leaves: originals, published copies, the list."""
    captures = spec / "captures"
    for folder in ("published/base", "published/task", "base", "task"):
        (captures / folder).mkdir(parents=True, exist_ok=True)
    before, after = png(64, 40, (148, 163, 184)), png(64, 40, (37, 99, 235))
    (captures / "published/base/settings.png").write_bytes(before)
    (captures / "published/task/settings.png").write_bytes(after)
    # The originals stay in the clone: no route ever reads them.
    (captures / "base/settings.png").write_bytes(before)
    (captures / "task/settings.png").write_bytes(after)
    (captures / "task/profile.png").write_bytes(png(64, 40, (220, 38, 38)))
    (captures / "publication.json").write_text(
        json.dumps(publication()), encoding="utf-8"
    )


def seed_app_cards(
    st: e2e.Stack, alice: e2e.Person, project: str, repos_root: Path
) -> dict[str, str]:
    """Create the cards on `project`'s board and leave the captures one's files."""
    titles = {"captures": CAPTURES_CARD, "emails": EMAILS_CARD, "invoice": INVOICE_CARD}
    for title in titles.values():
        card = st.ok(
            alice,
            "POST",
            "/api/board/cards",
            params={"project_id": project},
            json={"title": title, "description": _DESCRIPTIONS[title]},
        )
        if title == CAPTURES_CARD:
            # The server's clone of the project (``server.services.repos``).
            write_captures(repos_root / project / ".workpilot" / "specs" / card["id"])
    return titles

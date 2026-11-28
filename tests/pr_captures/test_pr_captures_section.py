"""The "Captures" section of a pull request body, and a person's "Publish"."""

from __future__ import annotations

import json

from pr_captures.approval import approve, approved_signatures, revoke
from pr_captures.section import (
    END,
    START,
    hosted_files,
    render_section,
    replace_section,
)


def _side(file: str, signature: str, publishable: bool = True) -> dict:
    return {
        "file": file if publishable else "",
        "signature": signature,
        "publishable": publishable,
    }


PUBLICATION = {
    "version": 1,
    "decision": {"needed": True},
    "settings": {"publish": "auto", "protect": True},
    "items": [
        {
            "key": "web|orders|",
            "label": "web final state",
            "platform": "web",
            "variant": "",
            "route": "orders",
            "before": _side("captures/published/base/web--orders.png", "b1"),
            "after": _side("captures/published/task/web--orders.png", "t1"),
            "publishable": True,
        },
        {
            "key": "web|orders||mobile",
            "label": "x",
            "platform": "web",
            "variant": "mobile",
            "route": "orders",
            "before": None,
            "after": _side("captures/published/task/web--orders--mobile.png", "t2"),
            "publishable": True,
        },
        {
            "key": "android||",
            "label": "Écran [commande](javascript:alert(1)) <b>|",
            "platform": "android",
            "variant": "",
            "route": "",
            "before": None,
            "after": _side("", "t3", publishable=False),
            "publishable": False,
        },
    ],
    "publishable": 2,
    "withheld": 1,
}

URLS = {
    "captures/published/base/web--orders.png": "https://h/o/r/blob/b/x/before/a.png?raw=1",
    "captures/published/task/web--orders.png": "https://h/o/r/blob/b/x/after/a.png?raw=1",
    "captures/published/task/web--orders--mobile.png": "https://h/o/r/blob/b/x/after/m.png?raw=1",
}


def test_the_files_a_pull_request_may_show():
    assert hosted_files(PUBLICATION) == [
        "captures/published/task/web--orders.png",
        "captures/published/base/web--orders.png",
        "captures/published/task/web--orders--mobile.png",
    ]
    # A reviewed team shows only what a person saw; an unseen "after" hides its "before".
    assert hosted_files(PUBLICATION, {"b1", "t2"}) == [
        "captures/published/task/web--orders--mobile.png"
    ]
    assert hosted_files({**PUBLICATION, "decision": {"needed": False}}) == []
    assert hosted_files(None) == []


def test_the_section_pairs_before_and_after_and_says_what_was_replaced():
    section = render_section(PUBLICATION, URLS, lang="fr")
    assert section.startswith(START) and section.rstrip().endswith(END)
    assert "| /orders | ![Avant /orders](" in section
    assert "| /orders · téléphone | — | ![Après /orders · téléphone](" in section
    assert "fausses valeurs du même format" in section
    assert "1 capture(s) restent sur la tâche" in section
    english = render_section(PUBLICATION, URLS, lang="en")
    assert "| Screen | Before | After |" in english
    unprotected = render_section(
        {**PUBLICATION, "settings": {"protect": False}}, URLS, lang="en"
    )
    assert "without replacing personal data" in unprotected


def test_a_label_from_the_verification_is_plain_text():
    shown = {**URLS, "captures/published/task/android.png": "https://h/a.png"}
    item = dict(PUBLICATION["items"][2])
    item.update(
        after=_side("captures/published/task/android.png", "t3"), publishable=True
    )
    section = render_section(
        {**PUBLICATION, "items": [item], "withheld": 0}, shown, lang="fr"
    )
    row = next(line for line in section.splitlines() if "a.png" in line)
    assert "javascript" in row  # the words stay, as words
    assert "](javascript" not in row and "<b>" not in row
    assert row.count("|") == 4


def test_a_bounded_description_drops_screens_from_the_end():
    full = render_section(PUBLICATION, URLS, lang="en")
    bounded = render_section(PUBLICATION, URLS, lang="en", max_chars=len(full) - 1)
    assert len(bounded) <= len(full) - 1
    assert "m.png" not in bounded and "1 more screen(s) on the task." in bounded
    assert render_section(PUBLICATION, URLS, lang="en", max_chars=20) == ""


def test_nothing_hosted_and_nothing_held_is_no_section():
    assert render_section(PUBLICATION, {}, lang="fr").count("![") == 0
    quiet = {**PUBLICATION, "withheld": 0}
    assert render_section(quiet, {}, lang="fr") == ""


def test_the_section_is_replaced_never_added_twice():
    body = "## Summary\n\nDone.\n"
    first = replace_section(body, "<!-- workpilot-captures:start -->\nA\n" + END + "\n")
    assert first.startswith("## Summary") and first.count(START) == 1
    second = replace_section(first, START + "\nB\n" + END + "\n")
    assert second.count(START) == 1 and "\nB\n" in second and "\nA\n" not in second
    assert replace_section(second, "").strip() == "## Summary\n\nDone."
    assert replace_section(body, "") == body
    assert replace_section(None, "") == ""


def test_a_person_approves_the_images_they_saw(tmp_path):
    spec = tmp_path / "spec"
    (spec / "captures").mkdir(parents=True)
    (spec / "captures" / "publication.json").write_text(
        json.dumps(PUBLICATION), encoding="utf-8"
    )
    assert approved_signatures(spec) == set()
    assert approve(spec) == 3
    assert approved_signatures(spec) == {"b1", "t1", "t2"}
    revoke(spec)
    assert approved_signatures(spec) == set()
    (spec / "captures" / "approval.json").write_text("nope", encoding="utf-8")
    assert approved_signatures(spec) == set()

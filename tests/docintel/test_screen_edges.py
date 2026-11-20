"""One captured screen, checked at the edges the visual QA rarely reaches.

The visual QA tests read real captures. This file calls the checks directly
with what those captures seldom show: a URL in the text, a locale that is not
one, a box at the very left edge, an empty screen, labels the task expected,
and placeholder text on a store screenshot.
"""

from __future__ import annotations

from docintel.engines.base import OcrBox
from docintel.screens import (
    check_screen,
    expected_on_screen,
    locale_from_url,
    placeholders,
    screen_kind,
    truncations,
    untranslated,
)


class TestReading:
    def test_a_link_is_not_an_untranslated_key(self):
        assert untranslated("see https:docs.example.com and mailto:team.lead") == []
        assert untranslated("checkout:button.pay") == [
            ("untranslated-key", "checkout:button.pay")
        ]

    def test_a_url_that_cannot_be_split_names_no_locale(self):
        assert locale_from_url("http://[::1") == ""

    def test_a_locale_parameter_that_is_no_locale_is_skipped(self):
        assert locale_from_url("https://app.test/?lang=42&lang=fr-FR") == "fr-FR"

    def test_a_box_at_the_left_edge_is_not_clipped(self):
        boxes = [OcrBox("Menu", 0, 0, 800, 20), OcrBox("Total", 700, 0, 99, 20)]

        findings = truncations([], [], boxes=boxes, width=800)

        assert [(f.kind, f.text) for f in findings] == [("clipped", "Total")]


class TestScreenKinds:
    def test_a_screen_without_labels_is_blank(self):
        assert screen_kind("", []) == ("blank", "")

    def test_placeholders_and_expected_labels_are_counted(self):
        assert placeholders("Lorem ipsum dolor sit amet — TODO") == [
            "Lorem ipsum",
            "dolor sit amet",
            "TODO",
        ]
        assert expected_on_screen(["Pay", "Cancel", "Help"], ["Pay"]) == (
            1,
            ["Cancel", "Help"],
        )


class TestOneScreen:
    def test_a_store_screen_missing_most_expected_labels_is_reported(self):
        text = "Checkout\nPay now\nLorem ipsum"
        labels = ["Checkout", "Pay now", "Lorem ipsum"]

        findings, info = check_screen(
            text,
            labels,
            expected=["Checkout", "Cart", "Shipping", "Billing"],
            store=True,
        )

        kinds = {(f.kind, f.text or f.detail) for f in findings}
        assert ("expected-screen", "1/4") in kinds
        assert ("placeholder", "Lorem ipsum") in kinds
        assert info["expected"] == {
            "found": 1,
            "total": 4,
            "missing": ["Cart", "Shipping", "Billing"],
        }

    def test_a_screen_showing_half_of_what_was_expected_is_not_reported(self):
        findings, info = check_screen(
            "Pay\nCart", ["Pay", "Cart"], expected=["Pay", "Cart", "Help"]
        )

        assert "expected-screen" not in {f.kind for f in findings}
        assert info["expected"]["found"] == 2

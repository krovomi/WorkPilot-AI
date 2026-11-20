"""Text drawn from memory notes reaches the advisor's prompt fenced."""

from __future__ import annotations

from brain.lifecycle import advisor


class TestMemoryAdvisor:
    def test_the_detector_detail_is_fenced_like_the_notes(self):
        text = advisor.build_prompt("a", "b", "retries: 3 ≠ 5")

        assert "flagged:\n<user_content>\nretries: 3 ≠ 5\n</user_content>" in text

    def test_no_detail_no_hint(self):
        assert "flagged" not in advisor.build_prompt("a", "b")

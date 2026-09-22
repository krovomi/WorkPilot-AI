import unittest

from agent_endpoints.code_review import analyze_diff


class CodeReviewContractTests(unittest.TestCase):
    def test_real_reviewer_returns_ui_contract_and_exact_path(self):
        result = analyze_diff(
            "diff --git a/backend/file name.py b/backend/file name.py\n--- /dev/null\n+++ b/backend/file name.py\n@@ -0,0 +42,1 @@\n+eval(user_input)\n"
        )
        self.assertIsInstance(result["score"], int)
        self.assertIsInstance(result["passed"], bool)
        self.assertTrue(result["issues"])
        issue = result["issues"][0]
        self.assertEqual(issue["file"], "backend/file name.py")
        self.assertEqual(issue["line"], 42)
        self.assertIn(issue["severity"], ["critical", "high", "medium", "low", "info"])

    def test_parser_preserves_code_which_starts_like_a_patch_header(self):
        from review.ai_code_review import parse_unified_diff

        files = parse_unified_diff(
            "diff --git a/backend/test.ts b/backend/test.ts\n"
            "--- a/backend/test.ts\n+++ b/backend/test.ts\n"
            "@@ -1,1 +8,2 @@\n---old\n+++counter;\n+done();\n"
        )
        self.assertEqual(files[0].added_lines, {8: "++counter;", 9: "done();"})
        self.assertEqual(files[0].removed_lines, {8: "--old"})

    def test_rejects_empty_or_excessive_input(self):
        for diff in ["", None, "x" * (2 * 1024 * 1024 + 1)]:
            with self.assertRaises(ValueError):
                analyze_diff(diff)


if __name__ == "__main__":
    unittest.main()

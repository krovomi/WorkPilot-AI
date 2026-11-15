"""The auto-fix statistics kept in the plan: runs, rates, common patterns.

The loop that records them is tested in `test_auto_fix_loop.py`.
"""

import json

import pytest
from qa.auto_fix_metrics import (
    AutoFixMetricsTracker,
    get_auto_fix_dashboard_data,
    get_auto_fix_stats,
    print_auto_fix_summary,
    record_auto_fix_run,
)


@pytest.fixture
def mock_spec_dir(tmp_path):
    """Create a mock spec directory."""
    spec_dir = tmp_path / ".workpilot" / "specs" / "001-test-spec"
    spec_dir.mkdir(parents=True)

    # Create implementation_plan.json
    plan = {"spec_name": "test-spec", "subtasks": []}
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )

    return spec_dir


class TestAutoFixMetrics:
    """Tests for AutoFixMetricsTracker."""

    def test_load_stats_no_file(self, mock_spec_dir):
        """Test loading stats when file doesn't exist."""
        # Remove implementation_plan.json
        (mock_spec_dir / "implementation_plan.json").unlink()

        tracker = AutoFixMetricsTracker(mock_spec_dir)
        stats = tracker.load_stats()

        assert stats.total_runs == 0
        assert stats.success_rate == 0

    def test_load_stats_no_stats(self, mock_spec_dir):
        """Test loading stats when stats don't exist."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)
        stats = tracker.load_stats()

        assert stats.total_runs == 0
        assert stats.success_rate == 0

    def test_record_run_success(self, mock_spec_dir):
        """Test recording a successful run."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(
            success=True,
            attempts=2,
            duration=45.3,
            error_patterns=["assertion_failure"],
            test_framework="pytest",
        )

        stats = tracker.load_stats()
        assert stats.total_runs == 1
        assert stats.successful_runs == 1
        assert stats.success_rate == 1
        assert stats.average_attempts == 2

    def test_record_run_failure(self, mock_spec_dir):
        """Test recording a failed run."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(
            success=False,
            attempts=5,
            duration=120.5,
            error_patterns=["import_error", "type_error"],
            test_framework="pytest",
        )

        stats = tracker.load_stats()
        assert stats.total_runs == 1
        assert stats.successful_runs == 0
        assert stats.success_rate == 0
        assert stats.average_attempts == 5

    def test_record_multiple_runs(self, mock_spec_dir):
        """Test recording multiple runs."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        # Record successful run
        tracker.record_run(success=True, attempts=2, duration=30.0)

        # Record failed run
        tracker.record_run(success=False, attempts=5, duration=60.0)

        # Record another successful run
        tracker.record_run(success=True, attempts=3, duration=45.0)

        stats = tracker.load_stats()
        assert stats.total_runs == 3
        assert stats.successful_runs == 2
        assert stats.success_rate == pytest.approx(0.666, rel=0.01)
        assert stats.average_attempts == pytest.approx(3.333, rel=0.01)

    def test_common_patterns_tracking(self, mock_spec_dir):
        """Test tracking common error patterns."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(
            success=True,
            attempts=2,
            duration=30.0,
            error_patterns=["assertion_failure"],
        )
        tracker.record_run(
            success=True,
            attempts=3,
            duration=40.0,
            error_patterns=["assertion_failure", "import_error"],
        )
        tracker.record_run(
            success=False,
            attempts=5,
            duration=60.0,
            error_patterns=["type_error"],
        )

        stats = tracker.load_stats()
        assert stats.common_patterns["assertion_failure"] == 2
        assert stats.common_patterns["import_error"] == 1
        assert stats.common_patterns["type_error"] == 1

    def test_get_dashboard_data(self, mock_spec_dir):
        """Test getting dashboard-ready data."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(success=True, attempts=2, duration=30.0)
        tracker.record_run(success=True, attempts=3, duration=40.0)

        dashboard = tracker.get_dashboard_data()

        assert dashboard["totalRuns"] == 2
        assert dashboard["successfulRuns"] == 2
        assert dashboard["successRate"] == 100
        assert dashboard["averageAttempts"] == pytest.approx(2.5)
        assert "commonPatterns" in dashboard
        assert "recentRuns" in dashboard

    def test_get_summary(self, mock_spec_dir):
        """Test getting human-readable summary."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(
            success=True,
            attempts=2,
            duration=30.0,
            error_patterns=["assertion_failure"],
        )

        summary = tracker.get_summary()

        assert "Total Runs: 1" in summary
        assert "Successful: 1" in summary
        assert "80.0%" in summary or "100.0%" in summary

    def test_reset_stats(self, mock_spec_dir):
        """Test resetting statistics."""
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        # Add some data
        tracker.record_run(success=True, attempts=2, duration=30.0)
        tracker.record_run(success=False, attempts=5, duration=60.0)

        # Reset
        tracker.reset_stats()

        # Verify reset
        stats = tracker.load_stats()
        assert stats.total_runs == 0
        assert stats.successful_runs == 0
        assert stats.success_rate == 0


class TestAutoFixPublicAPI:
    """Tests for public API functions."""

    def test_get_auto_fix_stats(self, mock_spec_dir):
        """Test get_auto_fix_stats public function."""
        # Record some runs first
        tracker = AutoFixMetricsTracker(mock_spec_dir)
        tracker.record_run(success=True, attempts=2, duration=30.0)

        stats = get_auto_fix_stats(mock_spec_dir)

        assert stats.total_runs == 1
        assert stats.successful_runs == 1

    def test_record_auto_fix_run(self, mock_spec_dir):
        """Test record_auto_fix_run public function."""
        record_auto_fix_run(
            mock_spec_dir,
            success=True,
            attempts=2,
            duration=30.0,
            error_patterns=["assertion_failure"],
            test_framework="pytest",
        )

        stats = get_auto_fix_stats(mock_spec_dir)
        assert stats.total_runs == 1
        assert stats.successful_runs == 1

    def test_get_auto_fix_dashboard_data(self, mock_spec_dir):
        """Test get_auto_fix_dashboard_data public function."""
        # Record some runs
        record_auto_fix_run(mock_spec_dir, success=True, attempts=2, duration=30.0)

        dashboard = get_auto_fix_dashboard_data(mock_spec_dir)

        assert dashboard["totalRuns"] == 1
        assert dashboard["successfulRuns"] == 1
        assert "successRate" in dashboard

    def test_print_auto_fix_summary(self, mock_spec_dir, capsys):
        """Test print_auto_fix_summary public function."""
        # Record some runs
        record_auto_fix_run(mock_spec_dir, success=True, attempts=2, duration=30.0)

        print_auto_fix_summary(mock_spec_dir)

        captured = capsys.readouterr()
        assert "Total Runs: 1" in captured.out
        assert "Successful: 1" in captured.out


class TestAHandEditedPlan:
    @pytest.mark.parametrize("text", ["{not json", "[1, 2]"])
    def test_an_unreadable_plan_reads_as_no_run(self, mock_spec_dir, text):
        (mock_spec_dir / "implementation_plan.json").write_text(text, encoding="utf-8")
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        assert tracker.load_stats().total_runs == 0
        tracker.record_run(success=True, attempts=1, duration=1.0)  # never raises
        tracker.reset_stats()  # never raises
        assert tracker.get_summary() == "No auto-fix runs recorded yet."

    def test_without_a_plan_nothing_is_recorded_or_reset(self, mock_spec_dir):
        (mock_spec_dir / "implementation_plan.json").unlink()
        tracker = AutoFixMetricsTracker(mock_spec_dir)

        tracker.record_run(success=True, attempts=1, duration=1.0)
        tracker.reset_stats()

        assert not (mock_spec_dir / "implementation_plan.json").exists()

    def test_stats_written_before_patterns_were_kept_get_them(self, mock_spec_dir):
        plan_file = mock_spec_dir / "implementation_plan.json"
        plan = json.loads(plan_file.read_text(encoding="utf-8"))
        plan["auto_fix_stats"] = {
            "total_runs": 1,
            "successful_runs": 1,
            "total_attempts": 2,
            "runs": [],
        }
        plan_file.write_text(json.dumps(plan), encoding="utf-8")

        record_auto_fix_run(
            mock_spec_dir, success=False, attempts=3, duration=5.0, error_patterns=["x"]
        )

        stats = get_auto_fix_stats(mock_spec_dir)
        assert stats.total_runs == 2 and stats.common_patterns == {"x": 1}

    def test_only_the_last_fifty_runs_are_kept(self, mock_spec_dir):
        tracker = AutoFixMetricsTracker(mock_spec_dir)
        for n in range(52):
            tracker.record_run(success=n % 2 == 0, attempts=n + 1, duration=1.0)

        stats = tracker.load_stats()
        assert stats.total_runs == 52
        assert [r["attempts"] for r in stats.runs][0] == 3
        assert len(stats.runs) == 50

    def test_an_empty_history_has_no_recent_run(self, mock_spec_dir):
        dashboard = get_auto_fix_dashboard_data(mock_spec_dir)

        assert dashboard["recentRuns"] == [] and dashboard["commonPatterns"] == []

    def test_the_dashboard_lists_the_five_most_common_patterns(self, mock_spec_dir):
        for n, pattern in enumerate("abcdef"):
            for _ in range(n + 1):
                record_auto_fix_run(
                    mock_spec_dir,
                    success=True,
                    attempts=1,
                    duration=1.0,
                    error_patterns=[pattern],
                )

        patterns = get_auto_fix_dashboard_data(mock_spec_dir)["commonPatterns"]

        assert [p["pattern"] for p in patterns] == ["f", "e", "d", "c", "b"]
        assert patterns[0]["count"] == 6

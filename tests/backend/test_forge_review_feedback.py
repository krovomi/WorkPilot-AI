"""Server mode: feedback on the findings of a server project's PR reviews (#361).

The review runs in the project's clone on the server; its feedback is written
to the clone's dataset, where the review job learns from it. These tests hold
the routes to what the runner saved (a finding id names a reviewed finding,
never a category or a title of the client's), hold a newcomer's rejection
until a maintainer decides, and keep reset and decisions to maintainers.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest
from fastapi import HTTPException
from learning_loop import review_feedback as rf
from pydantic import ValidationError
from server.authz.principal import Principal
from server.authz.scope import ProjectScope
from shared_features import forge_review_feedback as fb
from starlette.requests import Request

FINDINGS = [
    {
        "id": "f-1",
        "category": "style",
        "severity": "low",
        "title": "Missing docstring on `foo`",
    },
    {
        "id": "f-2",
        "category": "security",
        "severity": "high",
        "title": "SQL built by concatenation",
    },
    {"id": "bad-cat", "category": "Style!", "severity": "low", "title": "x"},
    {"id": "bad-sev", "category": "style", "severity": "huge", "title": "x"},
    {"id": "no-title", "category": "style", "severity": "low", "title": "  "},
    "not a finding",
]


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    reviews = tmp_path / ".workpilot" / "github" / "pr"
    reviews.mkdir(parents=True)
    (reviews / "review_5.json").write_text(
        json.dumps({"pr_number": 5, "findings": FINDINGS}), encoding="utf-8"
    )
    return tmp_path


def _scope(clone: Path, role: str | None = "member") -> ProjectScope:
    return ProjectScope("p-1", "o-1", clone, role)


def _request(**principal) -> Request:
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": []})
    request.state.principal = Principal(id="u-1", email="u@x.test", **principal)
    return request


def _set(clone, role="member", number=5, request=None, **body):
    body.setdefault("finding_id", "f-1")
    body.setdefault("verdict", "rejected")
    return asyncio.run(
        fb.set_feedback(
            number, fb.FeedbackIn(**body), request or _request(), _scope(clone, role)
        )
    )


def _lines(clone: Path) -> list[dict]:
    path = clone / ".workpilot" / "code_review_feedback.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text("utf-8").splitlines()]


def _status(call) -> int:
    with pytest.raises(HTTPException) as caught:
        call()
    return caught.value.status_code


class TestWhoIsAMaintainer:
    def test_the_owner_or_an_organization_administrator(self, clone):
        member = _request().state.principal
        admin = _request(permissions=frozenset({"project.member.write"}))
        assert fb.is_maintainer(_scope(clone, "owner"), member)
        assert not fb.is_maintainer(_scope(clone, "member"), member)
        assert not fb.is_maintainer(_scope(clone, None), member)
        assert fb.is_maintainer(_scope(clone, None), admin.state.principal)
        platform = _request(platform_role="admin").state.principal
        assert fb.is_maintainer(_scope(clone, None), platform)


class TestRecording:
    def test_an_owner_s_verdict_joins_the_dataset_with_the_saved_finding(self, clone):
        view = _set(
            clone,
            role="owner",
            reason="too_pedantic",
            note="  we\tdo not\x00 document helpers  ",
        )

        assert view == {"feedback": {"f-1": "rejected"}, "held": []}
        (line,) = _lines(clone)
        assert line["v"] == 1 and line["pr"] == 5 and line["at"]
        assert line["category"] == "style" and line["severity"] == "low"
        assert line["title"] == "Missing docstring on `foo`"
        assert line["note"] == "we do not document helpers"
        assert rf.load_feedback(clone)[0]["finding_id"] == "f-1"

    def test_an_acceptance_counts_at_once_and_drops_its_reason(self, clone):
        view = _set(clone, verdict="accepted", reason="other", note="n")

        assert view == {"feedback": {"f-1": "accepted"}, "held": []}
        (line,) = _lines(clone)
        assert line["reason"] is None and line["note"] == ""

    def test_a_member_s_rejection_is_held_and_never_learned(self, clone):
        view = _set(clone, verdict="not_applicable", reason="legacy_exception")

        assert view == {"feedback": {"f-1": "not_applicable"}, "held": ["f-1"]}
        assert _lines(clone) == []
        assert rf.load_feedback(clone) == []
        held = fb.read_held(_scope(clone))
        assert [(h["finding_id"], h["reason"]) for h in held] == [
            ("f-1", "legacy_exception")
        ]
        stored = (clone / ".workpilot" / fb.HELD_FILE).read_text("utf-8")
        assert "u-1" not in stored and "u@x.test" not in stored

    def test_a_later_rejection_replaces_the_held_one(self, clone):
        _set(clone, reason="other")
        _set(clone, verdict="not_applicable")

        held = fb.read_held(_scope(clone))
        assert [h["verdict"] for h in held] == ["not_applicable"]

    def test_an_acceptance_or_an_owner_settles_a_held_finding(self, clone):
        _set(clone)
        _set(clone, verdict="accepted")
        assert fb.read_held(_scope(clone)) == []
        _set(clone)
        _set(clone, role="owner", verdict="rejected")
        assert fb.read_held(_scope(clone)) == []
        assert [line["verdict"] for line in _lines(clone)] == ["accepted", "rejected"]

    def test_the_client_names_only_a_reviewed_finding(self, clone):
        for fid in ("missing", "bad-cat", "bad-sev", "no-title"):
            assert _status(lambda fid=fid: _set(clone, finding_id=fid)) == 404
        assert _status(lambda: _set(clone, number=6)) == 404
        assert _status(lambda: _set(clone, number=0)) == 422
        assert _lines(clone) == [] and fb.read_held(_scope(clone)) == []

    def test_an_unreadable_review_names_nothing(self, clone):
        review = clone / ".workpilot" / "github" / "pr" / "review_5.json"
        review.write_text("{not json", encoding="utf-8")
        assert _status(lambda: _set(clone)) == 404
        review.write_text(json.dumps({"findings": "none"}), encoding="utf-8")
        assert _status(lambda: _set(clone)) == 404

    def test_a_viewer_cannot_record(self, clone):
        assert _status(lambda: _set(clone, role="viewer")) == 403

    def test_the_body_is_a_closed_shape(self):
        for bad in (
            {"finding_id": "f-1", "verdict": "maybe"},
            {"finding_id": "f 1", "verdict": "accepted"},
            {"finding_id": "f-1", "verdict": "rejected", "reason": "boring"},
            {"finding_id": "f-1", "verdict": "rejected", "note": "x" * 281},
            {"finding_id": "f-1", "verdict": "accepted", "category": "security"},
            {"finding_id": "f-1", "verdict": "accepted", "title": "anything"},
        ):
            with pytest.raises(ValidationError):
                fb.FeedbackIn(**bad)
        with pytest.raises(ValidationError):
            fb.HeldDecision(pr=1, finding_id="f-1", approve=True, project_dir="/")
        with pytest.raises(ValidationError):
            fb.ResetIn(signature="../../etc")

    def test_the_dataset_is_compacted_past_its_bound(self, clone, monkeypatch):
        monkeypatch.setattr(fb, "MAX_FILE_BYTES", 600)
        monkeypatch.setattr(fb, "KEEP_LINES_ON_COMPACT", 2)
        for _ in range(4):
            _set(clone, role="owner", verdict="accepted")
        assert len(_lines(clone)) <= 3

    def test_a_link_out_of_the_clone_is_refused(self, clone, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        dataset = clone / ".workpilot" / "code_review_feedback.jsonl"
        dataset.symlink_to(outside / "x.jsonl")
        assert _status(lambda: _set(clone, role="owner")) == 409
        assert not (outside / "x.jsonl").exists()
        dataset.unlink()
        held = clone / ".workpilot" / fb.HELD_FILE
        held.symlink_to(outside / "held.json")
        assert _status(lambda: _set(clone)) == 409
        held.unlink()

    def test_a_workpilot_link_out_of_the_clone_is_refused(
        self, tmp_path, tmp_path_factory
    ):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "github" / "pr").mkdir(parents=True)
        (outside / "github" / "pr" / "review_5.json").write_text(
            json.dumps({"findings": FINDINGS}), encoding="utf-8"
        )
        (tmp_path / ".workpilot").symlink_to(outside, target_is_directory=True)
        assert _status(lambda: _set(tmp_path, role="owner")) == 409
        assert _status(lambda: asyncio.run(fb.get_feedback(5, _scope(tmp_path)))) == 409
        assert not (outside / "code_review_feedback.jsonl").exists()


class TestReading:
    def test_a_pr_s_verdicts_and_its_held_findings(self, clone):
        _set(clone, role="owner", verdict="accepted", finding_id="f-2")
        _set(clone)

        view = asyncio.run(fb.get_feedback(5, _scope(clone)))
        assert view == {
            "feedback": {"f-2": "accepted", "f-1": "rejected"},
            "held": ["f-1"],
        }
        assert asyncio.run(fb.get_feedback(6, _scope(clone))) == {
            "feedback": {},
            "held": [],
        }
        assert _status(lambda: asyncio.run(fb.get_feedback(0, _scope(clone)))) == 422

    def test_the_overview_is_the_dataset_the_threshold_and_the_held(
        self, clone, monkeypatch
    ):
        monkeypatch.setenv("WORKPILOT_REVIEW_FEEDBACK_THRESHOLD", "4")
        empty = asyncio.run(fb.feedback_overview(_request(), _scope(clone)))
        assert empty == {
            "dataset": "",
            "threshold": 4,
            "held": [],
            "maintainer": False,
            "reviews": [],
        }

        _set(clone, role="owner")
        _set(clone, finding_id="f-2", verdict="not_applicable")
        overview = asyncio.run(fb.feedback_overview(_request(), _scope(clone, "owner")))

        assert overview["maintainer"] is True
        assert '"finding_id": "f-1"' in overview["dataset"]
        assert [h["finding_id"] for h in overview["held"]] == ["f-2"]

    def test_an_unreadable_dataset_reads_as_empty(self, clone, monkeypatch):
        _set(clone, role="owner")

        def _boom(_path):
            raise OSError("gone")

        monkeypatch.setattr(fb.rf, "read_tail", _boom)
        overview = asyncio.run(fb.feedback_overview(_request(), _scope(clone)))
        assert overview["dataset"] == ""

    def test_a_held_file_that_is_not_a_list_of_records_reads_as_empty(self, clone):
        held = clone / ".workpilot" / fb.HELD_FILE
        for text in ("{broken", '{"a": 1}', "7"):
            held.write_text(text, encoding="utf-8")
            assert fb.read_held(_scope(clone)) == []
        held.write_text(
            json.dumps([{"v": 1, "pr": 5}, {**_record(), "note": 3, "at": 1}]),
            encoding="utf-8",
        )
        (item,) = fb.read_held(_scope(clone))
        assert item["note"] == "" and item["at"] == ""

    def test_the_held_list_is_bounded(self, clone, monkeypatch):
        monkeypatch.setattr(fb, "MAX_HELD", 2)
        for fid in ("f-1", "f-2", "f-1"):
            _set(clone, finding_id=fid)
        assert [h["finding_id"] for h in fb.read_held(_scope(clone))] == [
            "f-2",
            "f-1",
        ]


def _record(**extra) -> dict:
    return {
        "v": 1,
        "at": "2026-11-21T00:00:00+00:00",
        "pr": 5,
        "finding_id": "f-1",
        "verdict": "rejected",
        "reason": None,
        "note": "",
        "category": "style",
        "severity": "low",
        "title": "Missing docstring on `foo`",
        **extra,
    }


class TestMaintainerDecisions:
    def _decide(self, clone, role="owner", **body):
        body.setdefault("pr", 5)
        body.setdefault("finding_id", "f-1")
        body.setdefault("approve", True)
        return asyncio.run(
            fb.decide_held(fb.HeldDecision(**body), _request(), _scope(clone, role))
        )

    def test_an_approved_rejection_joins_the_dataset(self, clone):
        _set(clone, reason="project_convention", note="our style")

        assert self._decide(clone) == {"done": True}

        (line,) = _lines(clone)
        assert line["verdict"] == "rejected" and line["note"] == "our style"
        assert fb.read_held(_scope(clone)) == []
        assert rf.load_feedback(clone)[0]["reason"] == "project_convention"

    def test_a_discarded_one_leaves_no_trace(self, clone):
        _set(clone)
        self._decide(clone, approve=False)
        assert _lines(clone) == [] and fb.read_held(_scope(clone)) == []

    def test_only_a_maintainer_decides_and_only_on_a_held_one(self, clone):
        _set(clone)
        assert _status(lambda: self._decide(clone, role="member")) == 403
        assert _status(lambda: self._decide(clone, finding_id="f-2")) == 404
        assert len(fb.read_held(_scope(clone))) == 1

    def test_a_reset_is_a_maintainer_s_on_a_known_rule(self, clone):
        _set(clone, role="owner")
        sig = rf.signature("style", "Missing docstring on `foo`")

        def reset(role, signature=sig):
            return asyncio.run(
                fb.reset_rule(
                    fb.ResetIn(signature=signature), _request(), _scope(clone, role)
                )
            )

        assert _status(lambda: reset("member")) == 403
        assert _status(lambda: reset("owner", "0" * 16)) == 404
        assert reset("owner") == {"reset": True}
        assert _lines(clone)[-1]["kind"] == "reset"
        assert rf.load_feedback(clone) == []


def test_the_router_is_mounted_with_the_forge_feature():
    paths = {(next(iter(r.methods)), r.path) for r in fb.router.routes}
    assert ("POST", "/api/features/forge/github/reviews/{number}/feedback") in paths
    assert ("POST", "/api/features/forge/github/reviews/feedback/held") in paths
    assert os.path.basename(fb.__file__) == "forge_review_feedback.py"


class TestReviewCounts:
    """The findings count of each saved review, for the monthly figures (lot 4)."""

    def _review(self, clone: Path, name: str, content: str) -> None:
        (clone / ".workpilot" / "github" / "pr" / name).write_text(
            content, encoding="utf-8"
        )

    def test_each_saved_review_its_count_and_date_newest_first(self, clone):
        at = "2026-10-03T10:00:00.123456" + "x" * 30
        self._review(
            clone,
            "review_7.json",
            json.dumps({"reviewed_at": at, "findings": [1, 2, 3]}),
        )
        self._review(
            clone,
            "review_9.json",
            json.dumps({"reviewed_at": "2026-11-01T00:00:00", "findings": []}),
        )
        self._review(clone, "review_8.json", "{broken")
        self._review(
            clone,
            "review_10.json",
            json.dumps({"findings": "many", "reviewed_at": "x"}),
        )
        self._review(clone, "review_11.json", json.dumps([1]))
        self._review(
            clone, "review_010.json", json.dumps({"reviewed_at": at, "findings": []})
        )
        self._review(clone, "notes.json", "{}")

        counts = fb.review_counts(_scope(clone))

        # review_5 (the fixture) has no date; the others are not reviews.
        assert counts == [
            {"pr": 9, "at": "2026-11-01T00:00:00", "findings": 0},
            {"pr": 7, "at": at[:40], "findings": 3},
        ]
        overview = asyncio.run(fb.feedback_overview(_request(), _scope(clone)))
        assert overview["reviews"] == counts

    def test_the_newest_reviews_only(self, clone, monkeypatch):
        monkeypatch.setattr(fb, "MAX_COUNTED_REVIEWS", 1)
        for number in (6, 12):
            self._review(
                clone,
                f"review_{number}.json",
                json.dumps({"reviewed_at": "2026-11-01T00:00:00", "findings": [0]}),
            )

        assert [c["pr"] for c in fb.review_counts(_scope(clone))] == [12]

    def test_no_review_folder_counts_nothing(self, tmp_path):
        assert fb.review_counts(_scope(tmp_path)) == []

    def test_a_review_folder_that_leaves_the_clone_is_refused(self, tmp_path):
        clone = tmp_path / "clone"
        (clone / ".workpilot" / "github").mkdir(parents=True)
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "review_3.json").write_text(
            json.dumps({"reviewed_at": "2026-11-01T00:00:00", "findings": [1]}),
            encoding="utf-8",
        )
        (clone / ".workpilot" / "github" / "pr").symlink_to(
            elsewhere, target_is_directory=True
        )

        assert _status(lambda: fb.review_counts(_scope(clone))) == 409

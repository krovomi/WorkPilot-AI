"""Two replays side by side, and a replay as an MP4 (#347).

The comparison page puts two masked sessions in two columns, with no script
and its own CSP; its video opens the steps of both columns at once. An MP4
is the WebM encoded again by this machine's ffmpeg, in a folder of its own,
with an environment of its own; no ffmpeg is an answer, not an error. One
test encodes for real when this machine has ffmpeg.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from replay import api as replay_api
from replay import mp4, video
from replay import recorder as recorder_module
from replay.bundle import ExportOptions, build_bundle
from replay.compare_page import COMPARE_STYLE, render_comparison
from replay.models import ReplaySession, ReplayStep, ReplayStepType

from tests.replay.test_video import WEBM, FakeBrowser, _launcher

SECRET = "sk-ant-api03-" + "C" * 40  # pragma: allowlist secret


def _session(session_id: str, steps: int, **extra) -> ReplaySession:
    return ReplaySession(
        session_id=session_id,
        agent_name=f"coder {session_id}",
        start_time=1_700_000_000.0,
        status="completed",
        steps=[
            ReplayStep(
                id=f"{session_id}-{i}",
                step_index=i,
                step_type=ReplayStepType.TOOL_CALL,
                label=f"Step {i} of {session_id}",
            )
            for i in range(steps)
        ],
        **extra,
    )


def _bundle(session: ReplaySession, **options) -> dict:
    return build_bundle(session, ExportOptions(**options))


class TestComparisonPage:
    def test_two_columns_masked_escaped_and_without_script(self):
        left = _session("v1", 2, task_description=f"<b>key</b> {SECRET}")
        right = _session("v2", 1, total_tokens=42)
        page = render_comparison(_bundle(left), _bundle(right))
        assert page.startswith("<!doctype html>")
        assert page.count("<section class=side>") == 2
        assert page.index("Step 0 of v1") < page.index("Step 0 of v2")
        assert 'id="a-step-0"' in page and 'id="b-step-0"' in page
        assert 'id="step-0"' not in page
        assert "&lt;b&gt;key&lt;/b&gt;" in page
        assert SECRET not in page
        assert "<script" not in page
        digest = base64.b64encode(hashlib.sha256(COMPARE_STYLE.encode()).digest())
        assert f"style-src &#x27;sha256-{digest.decode()}&#x27;" in page
        assert "<dt>Tokens</dt><dd>42</dd>" in page

    def test_french_tokens_removed_and_an_empty_side(self):
        page = render_comparison(
            _bundle(_session("v1", 1), strip_tokens=True),
            _bundle(_session("v2", 0), strip_tokens=True),
            "fr",
        )
        assert '<html lang="fr">' in page
        assert "Rejeux d&#x27;agent côte à côte" in page
        assert "<dt>Tokens</dt>" not in page
        assert "Cette session n&#x27;a aucune étape." in page

    def test_an_unknown_language_is_english(self):
        page = render_comparison(
            _bundle(_session("a", 1)), _bundle(_session("b", 1)), "de"
        )
        assert '<html lang="en">' in page
        assert "Agent replays side by side" in page


class TestPlayingTwoColumns:
    def test_both_columns_open_their_steps_at_once(self):
        browser = FakeBrowser(steps=0)
        browser.columns = [2, 1]
        content, played, total = asyncio.run(
            video.record_video("<!doctype html>", launcher=_launcher(browser))
        )
        assert (content, played, total) == (WEBM, 2, 2)
        page = browser.contexts[0].page
        assert page is not None
        a = "main.pair > section.side[0] .steps > details"
        b = "main.pair > section.side[1] .steps > details"
        assert page.calls == [
            ("content", "<!doctype html>", "load"),
            ("wait", video.HOLD_MS),
            ("scroll", f"{a}[0] summary"),
            ("click", f"{a}[0] summary"),
            ("scroll", f"{b}[0] summary"),
            ("click", f"{b}[0] summary"),
            ("wait", video.MAX_STEP_MS),
            # Column A moves on; column B has run out and keeps its last step open.
            ("click", f"{a}[0] summary"),
            ("scroll", f"{a}[1] summary"),
            ("click", f"{a}[1] summary"),
            ("wait", video.MAX_STEP_MS),
            ("wait", video.HOLD_MS),
        ]


class FakeProcess:
    def __init__(self, code: int, target: Path | None, content: bytes, delay: float):
        self.code = code
        self.target = target
        self.content = content
        self.delay = delay
        self.killed = False

    async def wait(self) -> int:
        if self.delay and not self.killed:
            await asyncio.sleep(self.delay)
        if self.target is not None and self.code == 0:
            self.target.write_bytes(self.content)
        return self.code

    def kill(self) -> None:
        self.killed = True


def _fake_ffmpeg(monkeypatch, codes, content=b"mp4", delay=0.0, write=True):
    seen: list[tuple] = []

    async def start(ffmpeg, source, target, codec):
        seen.append((ffmpeg, source.name, target.name, codec[1], source.read_bytes()))
        return FakeProcess(
            codes[len(seen) - 1], target if write else None, content, delay
        )

    monkeypatch.setattr(mp4, "_start", start)
    return seen


class TestMp4:
    def test_h264_first(self, monkeypatch):
        seen = _fake_ffmpeg(monkeypatch, [0])
        assert asyncio.run(mp4.to_mp4(WEBM, ffmpeg="/usr/bin/ffmpeg")) == b"mp4"
        assert seen == [
            ("/usr/bin/ffmpeg", "replay.webm", "replay.mp4", "libx264", WEBM)
        ]

    def test_mpeg4_when_the_build_has_no_h264(self, monkeypatch):
        seen = _fake_ffmpeg(monkeypatch, [1, 0])
        assert asyncio.run(mp4.to_mp4(WEBM, ffmpeg="ffmpeg")) == b"mp4"
        assert [codec for _f, _s, _t, codec, _b in seen] == ["libx264", "mpeg4"]

    def test_no_encoder_that_works_is_a_failure(self, monkeypatch):
        _fake_ffmpeg(monkeypatch, [1, 1])
        with pytest.raises(video.VideoError, match="failed"):
            asyncio.run(mp4.to_mp4(WEBM, ffmpeg="ffmpeg"))
        # An exit code of 0 without a file is no MP4 either.
        _fake_ffmpeg(monkeypatch, [0, 0], write=False)
        with pytest.raises(video.VideoError, match="failed"):
            asyncio.run(mp4.to_mp4(WEBM, ffmpeg="ffmpeg"))

    def test_an_mp4_over_the_bound_is_refused(self, monkeypatch):
        monkeypatch.setattr(mp4, "MAX_VIDEO_BYTES", 2)
        _fake_ffmpeg(monkeypatch, [0], content=b"too big")
        with pytest.raises(video.VideoError, match="too_large"):
            asyncio.run(mp4.to_mp4(WEBM, ffmpeg="ffmpeg"))

    def test_an_encoding_past_its_deadline_is_stopped(self, monkeypatch):
        monkeypatch.setattr(mp4, "DEADLINE_SECONDS", 0.01)
        _fake_ffmpeg(monkeypatch, [0], delay=5)
        with pytest.raises(video.VideoError, match="timeout"):
            asyncio.run(mp4.to_mp4(WEBM, ffmpeg="ffmpeg"))

    def test_no_ffmpeg_is_an_answer(self, monkeypatch):
        monkeypatch.setattr(mp4, "find_ffmpeg", lambda: None)
        with pytest.raises(video.VideoUnavailable, match="no_mp4_encoder"):
            asyncio.run(mp4.to_mp4(WEBM))

    def test_an_ffmpeg_that_cannot_start_is_an_answer(self, tmp_path):
        missing = str(tmp_path / "no-such-ffmpeg")
        with pytest.raises(video.VideoUnavailable, match="no_mp4_encoder"):
            asyncio.run(mp4.to_mp4(WEBM, ffmpeg=missing))

    def test_ffmpeg_gets_an_environment_of_its_own(self, monkeypatch):
        monkeypatch.setenv("PATH", "/bin")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")
        env = mp4._env()
        assert env["PATH"] == "/bin"
        assert "ANTHROPIC_API_KEY" not in env
        assert set(env) <= set(mp4._ENV_KEYS)


def test_a_real_encoding_or_the_name_of_what_is_missing(tmp_path):
    """On this machine's ffmpeg: a real MP4, or the answer that there is none."""
    ffmpeg = mp4.find_ffmpeg()
    if not ffmpeg:
        with pytest.raises(video.VideoUnavailable, match="no_mp4_encoder"):
            asyncio.run(mp4.to_mp4(WEBM))
        return
    # A short source made with an encoder every ffmpeg has.
    source = tmp_path / "source.mkv"
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x48:rate=5:duration=1",
            "-c:v",
            "mpeg4",
            str(source),
        ],
        check=True,
        timeout=60,
    )
    data = asyncio.run(mp4.to_mp4(source.read_bytes(), ffmpeg=ffmpeg))
    assert data[4:8] == b"ftyp"


# -- the routes --------------------------------------------------------------


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    store = recorder_module.ReplayRecorder(storage_dir=tmp_path / "replays")
    monkeypatch.setattr(recorder_module, "_replay_recorder", store)
    store.save_session(_session("v1", 2))
    store.save_session(_session("v2", 1))
    app = FastAPI()
    app.include_router(replay_api.router)
    return TestClient(app)


def _recording(monkeypatch, seen: dict):
    async def record(html: str, *, executable: str = ""):
        seen["html"] = html
        return WEBM, 2, 2

    monkeypatch.setattr(replay_api.video_module, "record_video", record)


class TestRoutes:
    def test_two_sessions_are_recorded_side_by_side(self, client, monkeypatch):
        seen: dict = {}
        _recording(monkeypatch, seen)
        answer = client.post(
            "/replay/compare/video",
            json={"session_a_id": "v1", "session_b_id": "v2", "language": "fr"},
        ).json()
        assert answer["available"] is True
        assert answer["file_name"].endswith("-compare.webm")
        assert base64.b64decode(answer["content_base64"]) == WEBM
        assert "<main class=pair>" in seen["html"]
        assert '<html lang="fr">' in seen["html"]

    def test_a_missing_session_is_not_found(self, client):
        answer = client.post(
            "/replay/compare/video", json={"session_a_id": "v1", "session_b_id": "nope"}
        )
        assert answer.status_code == 404

    def test_an_mp4_is_the_webm_encoded_again(self, client, monkeypatch):
        _recording(monkeypatch, {})
        encoded: list[bytes] = []

        async def to_mp4(webm: bytes) -> bytes:
            encoded.append(webm)
            return b"\x00\x00\x00\x18ftypmp42"

        monkeypatch.setattr(replay_api.mp4_module, "to_mp4", to_mp4)
        answer = client.post("/replay/sessions/v1/video", json={"format": "mp4"}).json()
        assert encoded == [WEBM]
        assert answer["file_name"].endswith(".mp4")
        assert base64.b64decode(answer["content_base64"])[4:8] == b"ftyp"

    def test_no_ffmpeg_is_an_answer_not_an_error(self, client, monkeypatch):
        _recording(monkeypatch, {})

        async def to_mp4(webm: bytes) -> bytes:
            raise video.VideoUnavailable("no_mp4_encoder")

        monkeypatch.setattr(replay_api.mp4_module, "to_mp4", to_mp4)
        answer = client.post(
            "/replay/compare/video",
            json={"session_a_id": "v1", "session_b_id": "v2", "format": "mp4"},
        )
        assert answer.json() == {
            "success": True,
            "available": False,
            "refusal": "no_mp4_encoder",
        }
        bad = client.post("/replay/sessions/v1/video", json={"format": "avi"})
        assert bad.status_code == 422

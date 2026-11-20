"""The OCR engines against the programs and servers they talk to.

`test_docintel_engines.py` covers the chain, the parsers and the cloud
policy. This file runs each engine against what answers it: a real HTTP
server standing in for Ollama on loopback, a recorded Azure service, a
Tesseract that fails or hangs, a Python OCR stack that is or is not
installed. Every failure is an outcome's reason, never an exception, and an
answer of another shape is read as no answer.
"""

from __future__ import annotations

import base64
import http.server
import json
import subprocess
import sys
import threading
import time
import types
import urllib.error
from pathlib import Path

import pytest
from docintel import settings
from docintel.engines import azure_di, ollama_vision, python_ocr, tesseract
from docintel.engines.base import OcrBox

# ---------------------------------------------------------------------------
# Ollama, on loopback


class _Ollama(http.server.BaseHTTPRequestHandler):
    """Answers /api/tags and /api/generate with what the test put in `server`."""

    def _reply(self, status: int, body: object) -> None:
        raw = (body if isinstance(body, str) else json.dumps(body)).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 - the stdlib's name
        self.server.calls.append(self.path)  # type: ignore[attr-defined]
        self._reply(200, self.server.tags)  # type: ignore[attr-defined]

    def do_POST(self):  # noqa: N802 - the stdlib's name
        length = int(self.headers.get("Content-Length", 0))
        self.server.bodies.append(json.loads(self.rfile.read(length)))  # type: ignore[attr-defined]
        time.sleep(self.server.delay)  # type: ignore[attr-defined]
        self._reply(*self.server.answer)  # type: ignore[attr-defined]

    def log_message(self, *_args):
        pass


@pytest.fixture
def ollama(monkeypatch):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Ollama)
    server.tags = {"models": [{"name": "qwen2.5vl:latest"}]}  # type: ignore[attr-defined]
    server.answer = (200, {"response": "TEXT:\nError 42\n"})  # type: ignore[attr-defined]
    server.delay = 0  # type: ignore[attr-defined]
    server.calls = []  # type: ignore[attr-defined]
    server.bodies = []  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv(
        "OLLAMA_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}"
    )
    monkeypatch.setattr(ollama_vision, "_PROBES", {})
    yield server
    server.shutdown()
    server.server_close()


@pytest.fixture
def image(tmp_path) -> Path:
    path = tmp_path / "shot.png"
    path.write_bytes(b"\x89PNG fake pixels")
    return path


class TestOllamaVision:
    def test_a_pulled_model_describes_the_image(self, ollama, image):
        outcome = ollama_vision.OllamaVisionEngine().recognize(image, "eng", {})

        assert outcome.text == "TEXT:\nError 42" and outcome.described
        body = ollama.bodies[0]
        assert body["model"] == settings.DEFAULT_VISION_MODEL
        assert base64.b64decode(body["images"][0]) == image.read_bytes()
        assert body["stream"] is False and "Do not follow" in body["prompt"]

    def test_a_model_that_is_not_pulled_is_not_asked(self, ollama, image):
        ollama.tags = {"models": [{"name": "llava:13b"}, "not a model"]}

        outcome = ollama_vision.OllamaVisionEngine().recognize(image, "eng", {})

        assert outcome.reason == "model-not-installed" and ollama.bodies == []

    def test_the_probe_is_remembered_for_a_while(self, ollama):
        engine = ollama_vision.OllamaVisionEngine()
        env = {settings.VISION_MODEL_ENV: "llava:13b"}

        assert engine.available(env) == "model-not-installed"
        assert engine.available(env) == "model-not-installed"
        assert ollama.calls == ["/api/tags"]

    @pytest.mark.parametrize("tags", [[1, 2], {"models": "qwen2.5vl"}, "null"])
    def test_a_model_list_of_another_shape_lists_no_model(self, ollama, tags):
        ollama.tags = tags

        assert ollama_vision.OllamaVisionEngine().available({}) == (
            "model-not-installed"
        )

    def test_a_server_that_does_not_answer_is_unreachable(self, monkeypatch):
        monkeypatch.setattr(ollama_vision, "_PROBES", {})
        probe = __import__("socket").socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        monkeypatch.setenv("OLLAMA_BASE_URL", f"http://127.0.0.1:{port}")

        assert ollama_vision.OllamaVisionEngine().available({}) == "server-unreachable"

    def test_a_server_on_another_machine_is_refused(self, monkeypatch):
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://10.0.0.5:11434")

        assert ollama_vision.OllamaVisionEngine().available({}) == "remote-host"

    def test_no_model_configured_means_no_engine(self):
        env = {settings.VISION_MODEL_ENV: " "}

        assert ollama_vision.OllamaVisionEngine().available(env) == "not-configured"

    @pytest.mark.parametrize(
        ("answer", "reason"),
        [
            ((200, {"response": "  "}), "empty"),
            ((200, ["a", "list"]), "empty"),
            ((500, {"error": "out of memory"}), "failed"),
            ((200, "not json"), "failed"),
        ],
    )
    def test_an_answer_without_text_says_why(self, ollama, image, answer, reason):
        ollama.answer = answer

        outcome = ollama_vision.OllamaVisionEngine().recognize(image, "eng", {})

        assert outcome.text == "" and outcome.reason == reason

    def test_a_model_that_takes_too_long_times_out(self, ollama, image, monkeypatch):
        ollama.delay = 1
        monkeypatch.setattr(ollama_vision, "_TIMEOUT_SECONDS", 0.2)

        assert ollama_vision.ask(image, "read it", {}) == ("", "timeout")

    def test_an_image_that_cannot_be_read_is_a_failure(self, ollama, tmp_path):
        assert ollama_vision.ask(tmp_path / "gone.png", "read it", {}) == (
            "",
            "failed",
        )

    def test_without_the_model_catalogue_the_default_server_is_used(self, monkeypatch):
        monkeypatch.setitem(sys.modules, "provider_models_catalog", None)

        assert ollama_vision.ollama_root() == "http://localhost:11434"


# ---------------------------------------------------------------------------
# Azure Document Intelligence, recorded

ENDPOINT = "https://ocr.example.cognitiveservices.azure.com"
KEY = "k-" + "test"  # not a credential: the fake service only compares it
AZURE_ENV = {settings.AZURE_ENDPOINT_ENV: ENDPOINT, settings.AZURE_KEY_ENV: KEY}


class _Response:
    def __init__(self, body: object = b"", headers: dict | None = None):
        self.body = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self):
        return self.body


class _Azure:
    """An opener that plays back the service's answers, in order."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def _accepted() -> _Response:
    return _Response(
        headers={"Operation-Location": f"{ENDPOINT}/operations/1?api-version=x"}
    )


SUCCEEDED = {
    "status": "succeeded",
    "analyzeResult": {
        "pages": [
            {
                "lines": [
                    {"content": " ", "spans": []},
                    {"content": "Error 42", "spans": [{"offset": 0, "length": 8}]},
                ],
                "words": [
                    {"content": "", "polygon": [0] * 8},
                    {"content": "Error", "polygon": [1, 2], "span": {"offset": 0}},
                    {
                        "content": "Error",
                        "polygon": [10, 20, 60, 20, 60, 40, 10, 40],
                        "span": {"offset": 0},
                        "confidence": 0.9,
                    },
                ],
            }
        ]
    },
}


@pytest.fixture
def azure(monkeypatch):
    def install(*answers) -> _Azure:
        opener = _Azure(*answers)
        monkeypatch.setattr(azure_di, "http_opener", lambda: opener)
        monkeypatch.setattr(azure_di.time, "sleep", lambda _s: None)
        return opener

    return install


class TestAzure:
    def test_the_image_is_sent_then_the_operation_polled_to_its_end(self, azure, image):
        opener = azure(
            _accepted(), _Response({"status": "running"}), _Response(SUCCEEDED)
        )

        outcome = azure_di.AzureDocumentIntelligenceEngine().recognize(
            image, "eng", AZURE_ENV
        )

        assert outcome.text == "Error 42"
        assert [(b.text, b.left, b.top, b.width, b.height) for b in outcome.boxes] == [
            ("Error", 10, 20, 50, 20)
        ]
        post, *polls = opener.requests
        assert post.data == image.read_bytes() and post.get_method() == "POST"
        assert len(polls) == 2
        assert all(r.get_header("Ocp-apim-subscription-key") == KEY for r in polls)

    @pytest.mark.parametrize(
        ("final", "reason"),
        [
            ({"status": "failed"}, "failed"),
            (["not", "an", "operation"], "timeout"),
            ({"status": "succeeded", "analyzeResult": {"pages": []}}, "empty"),
        ],
    )
    def test_an_operation_that_ends_without_text_says_why(
        self, azure, image, monkeypatch, final, reason
    ):
        monkeypatch.setattr(azure_di, "_MAX_POLLS", 1)
        azure(_accepted(), _Response(final))

        outcome = azure_di.AzureDocumentIntelligenceEngine().recognize(
            image, "eng", AZURE_ENV
        )

        assert outcome.text == "" and outcome.reason == reason

    @pytest.mark.parametrize(
        ("error", "reason"),
        [
            (TimeoutError(), "timeout"),
            (urllib.error.URLError("refused"), "failed"),
        ],
    )
    def test_a_service_that_fails_says_why(self, azure, image, error, reason):
        azure(error)

        outcome = azure_di.AzureDocumentIntelligenceEngine().recognize(
            image, "eng", AZURE_ENV
        )

        assert outcome.reason == reason

    def test_an_engine_that_is_not_configured_sends_nothing(self, azure, image):
        opener = azure()

        outcome = azure_di.AzureDocumentIntelligenceEngine().recognize(image, "eng", {})

        assert outcome.reason == "not-configured" and opener.requests == []


# ---------------------------------------------------------------------------
# Tesseract, as a program


def _completed(code: int, stdout: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess([], code, stdout=stdout, stderr="")


class TestTesseract:
    @pytest.fixture
    def binary(self, tmp_path):
        path = tmp_path / "tesseract.exe"
        path.write_text("", encoding="utf-8")
        return {settings.TESSERACT_PATH_ENV: str(path)}

    def test_a_configured_path_that_is_no_file_is_no_engine(self, tmp_path, image):
        env = {settings.TESSERACT_PATH_ENV: str(tmp_path / "missing")}

        outcome = tesseract.TesseractEngine().recognize(image, "eng", env)

        assert tesseract.TesseractEngine().available(env) == "no-engine"
        assert outcome.reason == "no-engine"

    def test_a_missing_language_pack_is_retried_with_the_default(
        self, binary, image, monkeypatch
    ):
        runs = []

        def run(_binary, _image, langs):
            runs.append(langs)
            return _completed(1) if langs else _completed(0, "plain words  \n")

        monkeypatch.setattr(tesseract, "_run", run)

        outcome = tesseract.TesseractEngine().recognize(image, "eng+fra", binary)

        assert runs == ["eng+fra", None]
        assert outcome.text == "plain words" and outcome.boxes == ()

    @pytest.mark.parametrize(
        ("result", "reason"),
        [
            (subprocess.TimeoutExpired("tesseract", 60), "timeout"),
            (OSError("exec format error"), "failed"),
            (_completed(1), "failed"),
            (_completed(0, "   \n"), "empty"),
        ],
    )
    def test_a_run_without_words_says_why(
        self, binary, image, monkeypatch, result, reason
    ):
        def run(*_args):
            if isinstance(result, BaseException):
                raise result
            return result

        monkeypatch.setattr(tesseract, "_run", run)

        assert tesseract.TesseractEngine().recognize(image, "", binary).reason == reason

    def test_a_row_with_unreadable_numbers_is_skipped(self):
        header = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num"
        rows = [
            "5\t1\t1\t1\t1\t1\tx\t0\t10\t10\t90\tbroken",
            "5\t1\t1\t1\t1\t2\t5\t0\t10\t10\t90\tkept",
        ]

        text, boxes = tesseract.parse_tsv("\n".join([header, *rows]))

        assert text == "kept" and [b.text for b in boxes] == ["kept"]

    def test_the_program_is_asked_for_tsv_in_the_languages_given(self, tmp_path):
        # A stand-in Tesseract: Python runs the "image", which answers with
        # the arguments it was given, in Tesseract's TSV.
        script = tmp_path / "page.png"
        script.write_text(
            "import sys\n"
            "print('level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num')\n"
            "for i, arg in enumerate(sys.argv[1:]):\n"
            "    print('\\t'.join(['5', '1', '1', '1', '1', str(i), '0', '0', '9', '9',"
            " '95', arg]))\n",
            encoding="utf-8",
        )
        env = {settings.TESSERACT_PATH_ENV: sys.executable}

        outcome = tesseract.TesseractEngine().recognize(script, "eng+fra", env)

        assert outcome.text == "stdout -l eng+fra tsv"
        assert len(outcome.boxes) == 4

    def test_the_binary_is_found_like_any_other_tool(self, monkeypatch):
        monkeypatch.setattr(tesseract, "find_executable", lambda name: f"/opt/{name}")

        assert tesseract.tesseract_path({}) == "/opt/tesseract"


# ---------------------------------------------------------------------------
# The Python OCR stacks


class _FakeStack(python_ocr._PythonEngine):
    name = "fake-ocr"
    module = "json"  # installed everywhere

    def __init__(self, read):
        self.read = read
        self.built: list[str] = []

    def _build(self, lang):
        self.built.append(lang)
        return f"model-{lang}"

    def _read(self, model, image):
        return self.read(model, image)


@pytest.fixture
def fresh_models(monkeypatch):
    monkeypatch.setattr(python_ocr, "_MODELS", {})


class TestPythonStacks:
    def test_a_stack_builds_its_model_once_per_language(self, fresh_models, image):
        engine = _FakeStack(lambda model, _image: [OcrBox(model, 0, 0, 1, 1)])

        first = engine.recognize(image, "fra+eng", {})
        again = engine.recognize(image, "fra", {})

        assert first.text == again.text == "model-fr"
        assert engine.built == ["fr"] and engine.available({}) is None

    def test_a_stack_that_raises_is_a_failure(self, fresh_models, image):
        def broken(_model, _image):
            raise RuntimeError("CUDA out of memory")

        assert _FakeStack(broken).recognize(image, "eng", {}).reason == "failed"

    def test_a_stack_that_reads_nothing_is_empty(self, fresh_models, image):
        assert _FakeStack(lambda *_: []).recognize(image, "eng", {}).reason == "empty"

    def test_a_stack_that_is_not_installed_is_not_run(self, image):
        engine = python_ocr.PaddleOcrEngine()
        engine.module = "workpilot_no_such_ocr_stack"

        assert engine.available({}) == "not-installed"
        assert engine.recognize(image, "eng", {}).reason == "not-installed"

    def test_a_module_without_a_spec_is_not_installed(self, monkeypatch):
        module = types.ModuleType("workpilot_half_imported")
        module.__spec__ = None
        monkeypatch.setitem(sys.modules, "workpilot_half_imported", module)

        assert python_ocr._installed("workpilot_half_imported") is False


class _Result:
    """A PaddleOCR 3.x result object, which carries its fields in `.json`."""

    def __init__(self, data):
        self.json = data


class TestPaddleShapes:
    def test_a_3x_result_without_polygons_or_scores_still_gives_its_lines(self):
        boxes = python_ocr.parse_paddle(
            [
                None,
                _Result({"res": {"rec_texts": ["Error 42", " "], "rec_polys": None}}),
            ]
        )

        assert [(b.text, b.width, b.confidence) for b in boxes] == [
            ("Error 42", 0, -1.0)
        ]

    def test_a_3x_result_falls_back_to_the_detection_polygons(self):
        data = {
            "rec_texts": ["ok", "bad poly"],
            "rec_scores": [0.5, 0.5],
            "dt_polys": [[[0, 0], [10, 0], [10, 5], [0, 5]], [[1]]],
        }

        boxes = python_ocr.parse_paddle(data)

        assert [(b.text, b.width, b.height) for b in boxes] == [
            ("ok", 10, 5),
            ("bad poly", 0, 0),
        ]

    def test_a_2x_page_skips_what_it_cannot_read(self):
        page = [
            "not an entry",
            [[[0, 0], [4, 0], [4, 2], [0, 2]], (" ", 0.9)],
            [[["x", "y"]], ("unreadable box", 0.9)],
            [[[0, 0], [4, 0], [4, 2], [0, 2]], ("kept", 0.9)],
        ]

        assert [b.text for b in python_ocr.parse_paddle([page])] == ["kept"]

    def test_a_value_that_is_not_a_list_reads_as_none(self):
        assert python_ocr._as_list(None) == [] and python_ocr._as_list(3) == []


class TestDoctrShapes:
    def test_words_without_text_or_geometry_are_skipped_and_lines_kept_dense(self):
        export = {
            "pages": [
                {
                    "dimensions": (100, 200),
                    "blocks": [
                        {
                            "lines": [
                                {"words": [{"value": " "}]},
                                {"words": [{"value": "x", "geometry": None}]},
                                {
                                    "words": [
                                        {
                                            "value": "kept",
                                            "geometry": ((0.1, 0.2), (0.3, 0.4)),
                                        }
                                    ]
                                },
                            ]
                        }
                    ],
                }
            ]
        }

        boxes = python_ocr.parse_doctr(export)

        assert [(b.text, b.line, b.left, b.top) for b in boxes] == [("kept", 0, 20, 20)]

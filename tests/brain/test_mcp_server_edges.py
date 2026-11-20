"""The ``workpilot-brain`` MCP server on the calls the handshake and the
write/recall round trip in ``test_brain`` do not make."""

from __future__ import annotations

import io
import json

import pytest
from brain import Brain, mcp_server
from brain.mcp_server import _call, _utf8, handle, serve


@pytest.fixture
def brain(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.delenv(mcp_server.TASK_ENV, raising=False)
    monkeypatch.delenv(mcp_server.ORIGIN_ENV, raising=False)
    made = Brain(tmp_path / "brain")
    handle(made, {"jsonrpc": "2.0", "id": 0, "method": "initialize"})
    return made


def rpc(brain, method, params=None, msg_id=1) -> dict:
    return handle(
        brain,
        {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}},
    )


def tool(brain, tool_name: str, /, **arguments) -> dict:
    return rpc(brain, "tools/call", {"name": tool_name, "arguments": arguments})[
        "result"
    ]


def payload(reply: dict):
    assert reply["isError"] is False, reply
    text = reply["content"][0]["text"]
    try:
        return json.loads(text)
    except ValueError:
        return text


class TestGraphTools:
    @pytest.fixture
    def linked(self, brain):
        brain.write("Redis cache", "TTL 5 min, see [[Sessions]].", sync=False)
        brain.write("Sessions", "Stored in Redis.", sync=False)
        return brain

    def test_query_then_node_then_path(self, linked):
        [hit, *_] = payload(tool(linked, "query_graph", query="redis cache"))
        node = payload(tool(linked, "get_node", id=hit["id"]))
        sessions = payload(tool(linked, "query_graph", query="sessions"))[0]["id"]
        path = payload(tool(linked, "shortest_path", source=hit["id"], target=sessions))

        assert hit["label"] == "Redis cache"
        assert node["id"] == hit["id"] and node["neighbors"]
        assert path[0] == hit["id"] and path[-1] == sessions

    def test_a_limit_a_model_left_empty_is_the_default(self, linked):
        assert payload(tool(linked, "query_graph", query="redis", limit=None))
        assert payload(tool(linked, "brain_recall", query="redis", limit=None))["hits"]

    def test_a_limit_that_is_not_a_number_is_the_default(self, linked):
        assert payload(tool(linked, "query_graph", query="redis", limit={"n": 1}))


class TestOtherTools:
    def test_instructions_say_which_are_the_callers(self, brain):
        tool(brain, "brain_remember", text="Always answer in French", agent="codex")

        mine = payload(tool(brain, "brain_instructions", agent="codex"))
        theirs = payload(tool(brain, "brain_instructions", agent="hermes"))

        assert [item["yours"] for item in mine] == [True]
        assert [item["yours"] for item in theirs] == [False]

    def test_sync_and_status(self, brain):
        synced = payload(tool(brain, "brain_sync"))
        status = payload(tool(brain, "brain_status"))

        assert set(synced) >= {"committed", "pushed", "skipped"}
        assert status["root"] == str(brain.root)

    def test_a_skill_that_is_not_there(self, brain):
        reply = tool(brain, "brain_skill", name="nope")
        assert (
            reply["isError"] is True and "no skill named" in reply["content"][0]["text"]
        )

    def test_a_flag_is_not_a_line_number(self, brain):
        written = brain.write(
            "Long", "\n".join(f"line {n}" for n in range(1, 6)), sync=False
        )

        whole = payload(tool(brain, "brain_read_note", path=written.rel, offset=True))

        assert "line 1" in whole["body"] and "line 5" in whole["body"]

    @pytest.mark.parametrize(("tokens", "chars"), [("100", 1_000), ("0", None)])
    def test_a_client_cap_on_output_shrinks_a_page(self, monkeypatch, tokens, chars):
        monkeypatch.setenv(mcp_server.MCP_OUTPUT_TOKENS_ENV, tokens)
        expected = chars or mcp_server.READ_MAX_CHARS
        assert mcp_server.read_max_chars() == expected

    def test_the_task_given_is_the_one_recorded(self, brain):
        written = _call(
            brain,
            "brain_write_note",
            {"title": "Keys", "body": "Rotate them."},
            trusted=True,
            task="shop/007",
            max_chars=4000,
        )
        assert brain.read(written["path"])["frontmatter"]["tasks"] == ["shop/007"]

    def test_a_tool_the_server_does_not_have(self, brain):
        with pytest.raises(KeyError):
            _call(brain, "brain_explode", {}, trusted=True, task=None, max_chars=1)


class TestResources:
    def test_the_instructions_and_every_skill_are_listed_and_read(self, brain):
        listed = rpc(brain, "resources/list")["result"]["resources"]
        uris = [item["uri"] for item in listed]

        read = rpc(brain, "resources/read", {"uri": "brain://INSTRUCTIONS.md"})

        assert uris[0] == "brain://INSTRUCTIONS.md"
        assert "brain://skills/graph-first-recall" in uris
        assert read["result"]["contents"][0]["mimeType"] == "text/markdown"

    @pytest.mark.parametrize(
        ("uri", "said"),
        [
            ("brain://elsewhere", "unknown resource"),
            ("brain://skills/nope", "no skill named"),
        ],
    )
    def test_a_resource_that_is_not_there(self, brain, uri, said):
        reply = rpc(brain, "resources/read", {"uri": uri})
        assert reply["error"]["code"] == -32602 and said in reply["error"]["message"]

    def test_instructions_that_cannot_be_read(self, brain, monkeypatch):
        monkeypatch.setattr(
            mcp_server, "digest_path", lambda root: root / "nowhere" / "x.md"
        )
        reply = rpc(brain, "resources/read", {"uri": "brain://INSTRUCTIONS.md"})
        assert reply["error"]["code"] == -32602


class TestTransport:
    def test_initialize_leaves_an_existing_brain_as_it_is(self, brain, monkeypatch):
        monkeypatch.setattr(
            Brain, "init", lambda self, *a, **k: pytest.fail("init again")
        )
        reply = rpc(brain, "initialize", {"protocolVersion": "1999-01-01"})
        assert reply["result"]["protocolVersion"] == mcp_server.PROTOCOL_VERSIONS[0]

    def test_a_text_stream_is_left_as_it_is(self, caplog):
        stream = io.StringIO()
        with caplog.at_level("DEBUG", logger="brain.mcp_server"):
            assert _utf8(stream) is stream
        assert "stdio left as is" in caplog.text

    def test_a_byte_stream_is_put_in_utf8(self):
        stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
        assert _utf8(stream).encoding == "utf-8"

    def test_blank_lines_requests_that_are_not_objects_and_a_crash(
        self, brain, monkeypatch, capsys
    ):
        real = mcp_server.handle

        def crashing(b, message):
            if message.get("method") == "crash":
                raise RuntimeError("a bug in a tool")
            return real(b, message)

        monkeypatch.setattr(mcp_server, "handle", crashing)
        stdin = io.StringIO(
            "\n".join(
                [
                    "",
                    "   ",
                    json.dumps([1, 2]),
                    json.dumps({"jsonrpc": "2.0", "id": 9, "method": "crash"}),
                    json.dumps({"jsonrpc": "2.0", "id": 10, "method": "ping"}),
                ]
            )
        )
        stdout = io.StringIO()

        serve(brain, stdin=stdin, stdout=stdout)

        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        assert [(r["id"], r.get("error", {}).get("code")) for r in replies] == [
            (None, -32600),
            (9, -32603),
            (10, None),
        ]
        assert replies[1]["error"]["message"] == "a bug in a tool"
        assert "RuntimeError" in capsys.readouterr().err

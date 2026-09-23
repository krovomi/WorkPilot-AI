"""Tests for the shared brain (`apps/backend/brain/`).

What has to hold for "one brain, every agent" to be true rather than claimed:

* **the graph is Graphify's shape**, so the graph-first-recall skill and
  Graphify's own tools read it unchanged — and a graph Graphify wrote into the
  same file survives our rebuild;
* **a write on one machine is read on the other**, through nothing but git;
* **a conflict loses nothing** — both sides are on disk afterwards;
* **an agent's memory is ingested once, similar instructions merge**, and the
  bridge never re-imports the brain as if it were the agent's own memory;
* **other people's files are only written on request**, and never broken;
* **the MCP server speaks the protocol** an arbitrary client will send.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from brain import Brain  # noqa: E402
from brain.connect import SERVER_NAME, connect, connect_all  # noqa: E402
from brain.graph import ORIGIN, BrainGraph, build_graph, rebuild  # noqa: E402
from brain.mcp_server import TOOLS, handle, serve  # noqa: E402
from brain.memories import (  # noqa: E402
    BRIDGE_START,
    bridge,
    extract_instructions,
    ingest,
    instructions,
    refresh_bridges,
    remember,
    similarity,
)
from brain.notes import Note, body_tags, wikilinks, write_note  # noqa: E402
from brain.sync import sync  # noqa: E402

needs_git = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is not installed"
)


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("WORKPILOT_BRAIN_DIR", raising=False)
    monkeypatch.delenv("BRAIN_SIMILARITY", raising=False)
    monkeypatch.setattr(shutil, "which", _which_without_claude)
    return home


_real_which = shutil.which


def _which_without_claude(name, *args, **kwargs):
    # The Claude Code CLI, if installed on the test machine, would write the
    # real user's configuration.
    return None if name == "claude" else _real_which(name, *args, **kwargs)


def _note(root: Path, rel: str, body: str, **meta) -> None:
    write_note(root, Note(path=Path(rel), meta=meta, body=body))


# ---------------------------------------------------------------------------
# Notes and graph
# ---------------------------------------------------------------------------


def test_wikilinks_and_tags_follow_obsidian_syntax():
    body = "Voir [[Auth]] et [[notes/jwt#expiry|le JWT]], #securite\n```\n[[not-a-link]] #nope\n```\n"
    assert wikilinks(body) == ["Auth", "notes/jwt"]
    assert body_tags(body) == ["securite"]


def test_a_note_cannot_be_written_outside_the_brain(tmp_path):
    with pytest.raises(ValueError):
        write_note(tmp_path / "brain", Note(path=Path("../escape.md"), body="x"))


def test_the_graph_has_graphify_shape(tmp_path):
    root = tmp_path / "brain"
    _note(
        root,
        "knowledge/auth.md",
        "Décision : JWT. Voir [[jwt]] et [[Nobody wrote this]].",
        title="Auth",
        tags=["api"],
    )
    _note(root, "knowledge/jwt.md", "Tokens courts.", title="JWT")
    graph = build_graph(root)

    for node in graph["nodes"]:
        assert {"id", "label", "file_type", "source_file", "metadata"} <= node.keys()
    ids = {n["id"] for n in graph["nodes"]}
    assert {
        "knowledge/auth",
        "knowledge/jwt",
        "tag:api",
        "missing:Nobody wrote this",
    } <= ids
    pairs = {(link["source"], link["target"]) for link in graph["links"]}
    assert ("knowledge/auth", "knowledge/jwt") in pairs
    assert ("knowledge/auth", "tag:api") in pairs


def test_a_graph_graphify_wrote_survives_the_rebuild(tmp_path):
    root = tmp_path / "brain"
    _note(root, "knowledge/a.md", "A")
    out = root / "graphify-out" / "graph.json"
    out.parent.mkdir(parents=True)
    out.write_text(
        json.dumps(
            {
                "nodes": [
                    {
                        "id": "code:main",
                        "label": "main()",
                        "file_type": "code",
                        "source_file": "src/main.py",
                    }
                ],
                "links": [{"source": "code:main", "target": "code:main"}],
            }
        ),
        encoding="utf-8",
    )
    rebuild(root)
    rebuild(root)  # twice: our nodes are replaced, never duplicated
    data = json.loads(out.read_text(encoding="utf-8"))
    ids = [n["id"] for n in data["nodes"]]
    assert ids.count("knowledge/a") == 1
    assert "code:main" in ids
    assert {"source": "code:main", "target": "code:main"} in data["links"]
    assert all(
        n.get("metadata", {}).get("origin") == ORIGIN
        for n in data["nodes"]
        if n["id"] != "code:main"
    )


def test_graph_queries_answer_like_graphify_tools(tmp_path):
    root = tmp_path / "brain"
    _note(root, "knowledge/auth.md", "[[jwt]]", title="Authentification")
    _note(root, "knowledge/jwt.md", "[[keys]]", title="JWT")
    _note(root, "knowledge/keys.md", "rotation", title="Keys")
    rebuild(root)
    graph = BrainGraph.load(root)
    hits = graph.query("authentif")
    assert hits[0]["source_file"] == "knowledge/auth.md"
    assert any(n["id"] == "knowledge/jwt" for n in hits[0]["neighbors"])
    assert graph.shortest_path("knowledge/auth", "knowledge/keys") == [
        "knowledge/auth",
        "knowledge/jwt",
        "knowledge/keys",
    ]
    assert graph.get_node("nope") is None


# ---------------------------------------------------------------------------
# Instructions and agent memories
# ---------------------------------------------------------------------------


def test_extract_skips_structure_code_secrets_and_the_bridge():
    text = f"""---
title: x
---
# Heading
- Toujours répondre en français
- api_key: sk-abcdefghijklmnopqrstuvwxyz
```
- not an instruction inside code
```
@~/other.md
{BRIDGE_START}
- Instruction copied from the brain
<!-- workpilot-brain:end -->
Utiliser la clean architecture pour les Web API
"""
    assert extract_instructions(text) == [
        "Toujours répondre en français",
        "Utiliser la clean architecture pour les Web API",
    ]


def test_similarity_merges_rewordings_not_different_rules():
    assert (
        similarity("Réponds toujours en français", "Toujours répondre en français")
        >= 0.72
    )
    assert similarity("Always answer in French", "Answer in French, always") >= 0.72
    assert (
        similarity(
            "Préférer PostgreSQL", "Utiliser la clean architecture pour les Web API"
        )
        < 0.72
    )


def test_remember_reinforces_a_similar_instruction_instead_of_duplicating(tmp_path):
    root = tmp_path / "brain"
    first = remember(root, "Toujours répondre en français", agent_name="claude-code")
    second = remember(root, "Réponds toujours en français", agent_name="codex")
    third = remember(root, "Réponds toujours en français", agent_name="codex")
    assert (first.outcome, second.outcome, third.outcome) == (
        "created",
        "reinforced",
        "known",
    )
    assert second.rel == first.rel
    [only] = instructions(root)
    assert only.agents == ["claude-code", "codex"]


def test_remember_refuses_credentials(tmp_path):
    with pytest.raises(ValueError):
        remember(tmp_path / "brain", "token: ghp_abcdefghijklmnopqrstuvwxyz123456")


def test_ingest_snapshots_redacts_and_merges_across_agents(tmp_path, _isolated_home):
    (_isolated_home / ".claude").mkdir()
    (_isolated_home / ".claude" / "CLAUDE.md").write_text(
        "- Toujours répondre en français\n- password: hunter2hunter2\n",
        encoding="utf-8",
    )
    (_isolated_home / ".codex").mkdir()
    (_isolated_home / ".codex" / "AGENTS.md").write_text(
        "- Réponds toujours en français\n", encoding="utf-8"
    )
    root = tmp_path / "brain"
    report = ingest(root)
    assert (report.created, report.reinforced) == (1, 1)
    [only] = instructions(root)
    assert sorted(only.agents) == ["claude-code", "codex"]
    assert "hunter2" not in "".join(
        p.read_text(encoding="utf-8") for p in root.rglob("*.md")
    )
    assert (root / "INSTRUCTIONS.md").is_file()


def test_bridge_previews_then_writes_additively_and_is_idempotent(
    tmp_path, _isolated_home
):
    root = tmp_path / "brain"
    remember(
        root,
        "Utiliser la clean architecture pour les Web API",
        agent_name="claude-code",
    )
    remember(root, "Toujours répondre en français", agent_name="claude-code")
    memory = _isolated_home / ".codex" / "AGENTS.md"
    memory.parent.mkdir()
    memory.write_text(
        "# Mes règles\n\n- Réponds toujours en français\n", encoding="utf-8"
    )

    preview = bridge(root, "codex")
    assert preview.action == "preview"
    assert BRIDGE_START not in memory.read_text(encoding="utf-8")

    written = bridge(root, "codex", apply=True)
    text = memory.read_text(encoding="utf-8")
    assert written.action == "written" and Path(written.backup).is_file()
    assert text.startswith(
        "# Mes règles\n\n- Réponds toujours en français\n"
    )  # the agent's own words stay
    new_part = text.split("en plus des tiennes\n", 1)[1]
    assert "clean architecture" in new_part.split("###")[0]
    assert (
        "Toujours répondre en français" in new_part
    )  # listed as reinforced, not as new
    assert bridge(root, "codex", apply=True).action == "unchanged"

    # The bridged file ingested back must not credit the brain's text to codex.
    ingest(root, names=["codex"])
    clean = next(i for i in instructions(root) if "clean architecture" in i.text)
    assert clean.agents == ["claude-code"]


def test_refresh_only_touches_files_that_were_bridged(tmp_path, _isolated_home):
    root = tmp_path / "brain"
    remember(root, "Documenter chaque endpoint public", agent_name="brain")
    gemini = _isolated_home / ".gemini" / "GEMINI.md"
    gemini.parent.mkdir()
    gemini.write_text("- rule of my own here\n", encoding="utf-8")
    assert refresh_bridges(root) == []
    assert gemini.read_text(encoding="utf-8") == "- rule of my own here\n"


# ---------------------------------------------------------------------------
# Pull / push
# ---------------------------------------------------------------------------


@needs_git
def test_a_write_on_one_clone_is_read_on_the_other(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    a = Brain(tmp_path / "A")
    a.init(remote=str(remote))
    b = Brain(tmp_path / "B")
    b.init(remote=str(remote))

    written = a.write(
        "Choix de la base",
        "PostgreSQL, voir [[jwt]].",
        tags=["decision"],
        agent="codex",
    )
    assert written.sync.pushed

    hits = b.recall("choix base")["hits"]
    assert hits and hits[0]["source_file"] == "knowledge/choix-de-la-base.md"
    assert hits[0]["frontmatter"]["agents"] == ["codex"]
    assert "PostgreSQL" in b.read("knowledge/choix-de-la-base")["body"]


@needs_git
def test_edits_made_outside_any_agent_are_pushed_by_the_next_sync(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    a = Brain(tmp_path / "A")
    a.init(remote=str(remote))
    (a.root / "knowledge" / "obsidian.md").write_text(
        "typed in Obsidian\n", encoding="utf-8"
    )
    result = a.sync()
    assert result.committed and result.pushed
    b = Brain(tmp_path / "B")
    b.init(remote=str(remote))
    assert (b.root / "knowledge" / "obsidian.md").read_text(
        encoding="utf-8"
    ) == "typed in Obsidian\n"


@needs_git
def test_a_conflict_keeps_both_sides(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    a = Brain(tmp_path / "A")
    a.init(remote=str(remote))
    b = Brain(tmp_path / "B")
    b.init(remote=str(remote))
    (a.root / "knowledge" / "x.md").write_text("écrit par A\n", encoding="utf-8")
    sync(a.root, "a")
    (b.root / "knowledge" / "x.md").write_text("écrit par B\n", encoding="utf-8")
    result = sync(b.root, "b")

    assert result.conflicts == ["knowledge/x.md"]
    assert result.pushed
    assert (b.root / "knowledge" / "x.md").read_text(
        encoding="utf-8"
    ) == "écrit par B\n"
    [theirs] = list((b.root / "knowledge").glob("x.conflict-*.md"))
    assert theirs.read_text(encoding="utf-8") == "écrit par A\n"


@needs_git
def test_without_a_remote_the_brain_still_commits(tmp_path):
    brain = Brain(tmp_path / "solo")
    brain.init()
    result = brain.write("Note", "local only").sync
    assert result.committed and result.skipped == "no-remote"


# ---------------------------------------------------------------------------
# Connecting agents
# ---------------------------------------------------------------------------


def test_connect_json_preserves_the_file_and_is_idempotent(tmp_path, _isolated_home):
    cfg = _isolated_home / ".gemini" / "settings.json"
    cfg.parent.mkdir()
    cfg.write_text(
        json.dumps({"theme": "dark", "mcpServers": {"other": {"command": "x"}}}),
        encoding="utf-8",
    )
    root = tmp_path / "brain"
    assert connect(root, "gemini").action == "preview"
    assert connect(root, "gemini", apply=True).action == "written"
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["theme"] == "dark" and "other" in data["mcpServers"]
    assert data["mcpServers"][SERVER_NAME]["env"]["WORKPILOT_BRAIN_DIR"] == str(root)
    assert connect(root, "gemini", apply=True).action == "unchanged"


def test_connect_never_rewrites_a_file_it_cannot_parse(tmp_path, _isolated_home):
    cfg = _isolated_home / ".cursor" / "mcp.json"
    cfg.parent.mkdir()
    cfg.write_text("{ not json", encoding="utf-8")
    result = connect(tmp_path / "brain", "cursor", apply=True)
    assert result.action == "error"
    assert cfg.read_text(encoding="utf-8") == "{ not json"


def test_connect_toml_block_is_replaced_not_appended(tmp_path, _isolated_home):
    cfg = _isolated_home / ".codex" / "config.toml"
    cfg.parent.mkdir()
    cfg.write_text('model = "o4"  # mine\n', encoding="utf-8")
    connect(tmp_path / "one", "codex", apply=True)
    connect(tmp_path / "two", "codex", apply=True)
    text = cfg.read_text(encoding="utf-8")
    assert text.startswith('model = "o4"  # mine\n')
    assert text.count(f"[mcp_servers.{SERVER_NAME}]") == 1
    assert str(tmp_path / "two") in text


def test_connect_hermes_leaves_an_existing_mcp_servers_map_to_the_person(
    tmp_path, _isolated_home
):
    cfg = _isolated_home / ".hermes" / "config.yaml"
    cfg.parent.mkdir()
    cfg.write_text("mcp_servers:\n  github: {command: gh}\n", encoding="utf-8")
    result = connect(tmp_path / "brain", "hermes", apply=True)
    assert result.action == "manual" and SERVER_NAME in result.snippet
    assert cfg.read_text(encoding="utf-8") == "mcp_servers:\n  github: {command: gh}\n"


def test_connect_all_does_not_install_config_for_absent_agents(
    tmp_path, _isolated_home
):
    results = {r.agent: r.action for r in connect_all(tmp_path / "brain", apply=True)}
    assert results["cursor"] == "absent"
    assert not (_isolated_home / ".cursor").exists()


# ---------------------------------------------------------------------------
# MCP server
# ---------------------------------------------------------------------------


def _rpc(brain, method, params=None, msg_id=1):
    return handle(
        brain,
        {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params or {}},
    )


def test_mcp_handshake_lists_tools_and_carries_the_rules(tmp_path):
    brain = Brain(tmp_path / "brain")
    init = _rpc(
        brain, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}}
    )["result"]
    assert init["protocolVersion"] == "2025-03-26"
    assert "en plus" in init["instructions"].lower()
    assert brain.exists  # connecting to a brain that is not there creates it
    assert (
        handle(brain, {"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    )
    names = {t["name"] for t in _rpc(brain, "tools/list")["result"]["tools"]}
    assert {
        "brain_recall",
        "query_graph",
        "get_node",
        "shortest_path",
        "brain_read_note",
        "brain_write_note",
    } <= names
    for tool in TOOLS:
        assert tool["inputSchema"]["type"] == "object"


def test_mcp_write_then_recall_then_read(tmp_path):
    brain = Brain(tmp_path / "brain")
    _rpc(brain, "initialize")
    call = _rpc(
        brain,
        "tools/call",
        {
            "name": "brain_write_note",
            "arguments": {
                "title": "Cache Redis",
                "body": "TTL 5 min",
                "agent": "hermes",
            },
        },
    )["result"]
    assert call["isError"] is False
    recall = json.loads(
        _rpc(
            brain,
            "tools/call",
            {"name": "brain_recall", "arguments": {"query": "redis"}},
        )["result"]["content"][0]["text"]
    )
    assert recall["level"] == "graph" and recall["hits"][0]["frontmatter"][
        "agents"
    ] == ["hermes"]
    body = json.loads(
        _rpc(
            brain,
            "tools/call",
            {
                "name": "brain_read_note",
                "arguments": {"path": recall["hits"][0]["source_file"]},
            },
        )["result"]["content"][0]["text"]
    )["body"]
    assert "TTL 5 min" in body


def test_mcp_serves_the_graph_first_recall_skill(tmp_path):
    brain = Brain(tmp_path / "brain")
    _rpc(brain, "initialize")
    listed = _rpc(brain, "tools/call", {"name": "brain_skill", "arguments": {}})[
        "result"
    ]["content"][0]["text"]
    assert "graph-first-recall" in listed
    skill = _rpc(brain, "resources/read", {"uri": "brain://skills/graph-first-recall"})[
        "result"
    ]["contents"][0]["text"]
    from skills_registry.frontmatter import parse_frontmatter

    meta, body = parse_frontmatter(skill)
    assert meta["name"] == "graph-first-recall"
    assert "brain_recall" in body and "query_graph" in body


def test_mcp_errors_are_reported_not_raised(tmp_path):
    brain = Brain(tmp_path / "brain")
    assert _rpc(brain, "tools/call", {"name": "nope"})["error"]["code"] == -32602
    bad = _rpc(
        brain,
        "tools/call",
        {"name": "brain_read_note", "arguments": {"path": "../../etc/passwd"}},
    )["result"]
    assert bad["isError"] is True
    assert _rpc(brain, "no/such")["error"]["code"] == -32601


def test_serve_reads_lines_and_writes_one_reply_per_request(tmp_path):
    brain = Brain(tmp_path / "brain")
    stdin = io.StringIO(
        "\n".join(
            [
                json.dumps(
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}
                ),
                json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                "not json",
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            ]
        )
    )
    stdout = io.StringIO()
    serve(brain, stdin=stdin, stdout=stdout)
    replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert [r.get("id") for r in replies] == [1, None, 2]
    assert replies[1]["error"]["code"] == -32700


def test_the_registered_command_starts_a_working_server(tmp_path):
    import os

    env = {**os.environ, "WORKPILOT_BRAIN_DIR": str(tmp_path / "brain")}
    done = subprocess.run(
        [sys.executable, str(BACKEND / "runners" / "brain_mcp.py")],
        input=json.dumps(
            {"jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {}}
        )
        + "\n",
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )
    reply = json.loads(done.stdout.splitlines()[0])
    assert reply["id"] == 7 and reply["result"]["serverInfo"]["name"] == SERVER_NAME

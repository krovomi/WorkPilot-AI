"""The brain, as one object: what every surface (MCP, CLI, HTTP) calls.

Every write goes through `Brain.write` and ends the same way — graph rebuilt,
digest rewritten, bridges refreshed, commit, pull, push — so no surface can
leave the brain half-updated or unpushed. Every read goes through
`Brain.before_read`, which pulls when the local copy is older than
``BRAIN_PULL_INTERVAL``.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .graph import BrainGraph, rebuild
from .home import KINDS, brain_dir, graph_path, kind_dir
from .memories import refresh_bridges, remember, write_digest
from .notes import Note, iter_notes, now_iso, read_note, slugify, write_note
from .sync import SyncResult, ensure_repo, pull_if_stale, remote_url, set_remote, sync

__all__ = ["Brain", "SEED_DIR"]

SEED_DIR = Path(__file__).resolve().parent / "seed"

_README = """# WorkPilot Brain

Un seul cerveau, tous tes agents. Ce dossier est un vault Obsidian (ouvre-le dans
Obsidian : « Open folder as vault »), un graphe au format Graphify
(`graphify-out/graph.json`) et un dépôt git synchronisé.

Aucun agent ne le possède : Claude Code, Codex, Hermes, OpenClaw, Gemini, Cursor…
le lisent et l'écrivent via le serveur MCP `workpilot-brain`.

| Dossier | Contenu |
|---|---|
| `instructions/` | une instruction partagée par note — `agents:` dit quels agents la suivent |
| `knowledge/` | décisions, faits, emplacements |
| `agents/` | instantanés des mémoires propres à chaque agent |
| `skills/` | skills communs (dont `graph-first-recall`) |
| `INSTRUCTIONS.md` | condensé généré des instructions actives |

Tu peux éditer à la main : la prochaine synchronisation committe et pousse tes changements.
"""

_AGENTS_MD = """# Utiliser ce cerveau

1. **Rappel** : applique `skills/graph-first-recall/SKILL.md` — graphe, puis index, puis fichier.
2. **Instructions** : `INSTRUCTIONS.md` s'applique en plus des tiennes. Similaire = renforcé, pas en double.
3. **Écriture** : une note par idée, des `[[liens]]` vers ce qu'elle concerne, du frontmatter
   (`title`, `tags`, `status`). Le graphe est reconstruit à chaque écriture.
"""


def _auto(var: str) -> bool:
    return os.environ.get(var, "true").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )


@dataclass
class WriteResult:
    rel: str
    created: bool
    sync: SyncResult

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.rel, "created": self.created, "sync": self.sync.to_dict()}


class Brain:
    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root).expanduser() if root else brain_dir()

    # -- lifecycle ---------------------------------------------------------

    @property
    def exists(self) -> bool:
        return (self.root / "README.md").is_file()

    def init(self, remote: str | None = None) -> dict[str, Any]:
        """Create the vault if needed and seed it. Idempotent; never overwrites a note."""
        self.root.mkdir(parents=True, exist_ok=True)
        cloned = False
        if (
            remote
            and not (self.root / ".git").exists()
            and not any(self.root.iterdir())
        ):
            # An existing brain on another machine: clone it rather than start a
            # second one that would have to be merged into it later.
            import subprocess

            done = subprocess.run(
                ["git", "clone", "-q", remote, str(self.root)],
                capture_output=True,
                text=True,
                timeout=120,
            )
            cloned = done.returncode == 0
        ensure_repo(self.root)
        if remote and remote_url(self.root) != remote:
            set_remote(self.root, remote)
        for folder in KINDS.values():
            (self.root / folder).mkdir(exist_ok=True)
        for name, text in (("README.md", _README), ("AGENTS.md", _AGENTS_MD)):
            if not (self.root / name).exists():
                (self.root / name).write_text(text, encoding="utf-8")
        seeded = self._seed()
        self._refresh()
        result = sync(self.root, "brain: init")
        return {
            "root": str(self.root),
            "cloned": cloned,
            "seeded": seeded,
            "remote": remote_url(self.root),
            "sync": result.to_dict(),
        }

    def _seed(self) -> list[str]:
        seeded = []
        for src in sorted(SEED_DIR.rglob("*")):
            if not src.is_file():
                continue
            rel = src.relative_to(SEED_DIR)
            dest = self.root / rel
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            seeded.append(rel.as_posix())
        return seeded

    def _refresh(self) -> None:
        rebuild(self.root)
        write_digest(self.root)

    def graph_is_stale(self) -> bool:
        path = graph_path(self.root)
        if not path.is_file():
            return True
        built = path.stat().st_mtime
        return any(
            (self.root / rel).stat().st_mtime > built for rel in iter_notes(self.root)
        )

    # -- sync --------------------------------------------------------------

    def before_read(self) -> SyncResult | None:
        result = pull_if_stale(self.root) if _auto("BRAIN_AUTO_PULL") else None
        if (result and result.pulled) or self.graph_is_stale():
            self._refresh()
        return result

    def after_write(self, message: str) -> SyncResult:
        self._refresh()
        return self.sync(message, push=_auto("BRAIN_AUTO_PUSH"))

    def sync(self, message: str = "brain: sync", *, push: bool = True) -> SyncResult:
        """Commit, pull, push — then rebuild what the pull may have changed.

        The graph and the digest are derived, so they are git-ignored and
        rebuilt here rather than committed: two machines each adding a note
        would otherwise conflict on ``graph.json`` at every single sync.
        """
        refresh_bridges(self.root)
        result = sync(self.root, message, push=push)
        if result.pulled or self.graph_is_stale():
            self._refresh()
            refresh_bridges(self.root)
        return result

    # -- write -------------------------------------------------------------

    def write(
        self,
        title: str,
        body: str,
        *,
        kind: str = "knowledge",
        tags: list[str] | None = None,
        links: list[str] | None = None,
        agent: str | None = None,
        path: str | None = None,
        trusted: bool = True,
    ) -> WriteResult:
        """Create or update a note, then sync. An existing note keeps its frontmatter.

        ``trusted=False`` is a write from one of WorkPilot's own agents, which
        may have read untrusted content (an issue, a PR, a web page) in the
        same session. Such a write may add or update *knowledge* — recalled on
        demand, read as data — and may *propose* a new instruction; it may not
        touch an instruction in force, a skill every agent loads, an agent's
        memory snapshot or the brain's own files.
        """
        folder = kind_dir(self.root, kind).name
        rel = Path(path) if path else Path(folder) / f"{slugify(title)}.md"
        if rel.suffix != ".md":
            rel = rel.with_suffix(".md")
        if rel.is_absolute() or ".." in rel.parts:
            raise ValueError("a note path is relative to the brain and stays inside it")
        created = not (self.root / rel).exists()
        is_instruction = rel.parts[0] == KINDS["instruction"]
        if not trusted:
            if rel.parts[0] not in (KINDS["knowledge"], KINDS["instruction"]):
                raise ValueError(
                    "an agent writes knowledge/ notes, or proposes instructions"
                )
            if is_instruction and not created:
                raise ValueError(
                    "an instruction in the brain is changed by a person; "
                    "propose a new one with brain_remember"
                )
        meta: dict[str, Any] = {} if created else dict(read_note(self.root, rel).meta)
        if is_instruction and created:
            meta["status"] = "active" if trusted else "proposed"
        meta.setdefault("kind", kind)
        meta["title"] = title
        meta.setdefault("created", now_iso())
        meta["updated"] = now_iso()
        merged_tags = list(dict.fromkeys([*(meta.get("tags") or []), *(tags or [])]))
        if merged_tags:
            meta["tags"] = merged_tags
        if agent:
            agents = list(meta.get("agents") or [])
            if agent not in agents:
                agents.append(agent)
            meta["agents"] = agents
        text = body.strip() + "\n"
        extra = [f"[[{link}]]" for link in (links or []) if f"[[{link}]]" not in text]
        if extra:
            text += "\n## Liens\n\n" + "\n".join(f"- {item}" for item in extra) + "\n"
        write_note(self.root, Note(path=rel, meta=meta, body=text))
        verb = "add" if created else "update"
        who = f" ({agent})" if agent else ""
        return WriteResult(
            rel.as_posix(),
            created,
            self.after_write(f"brain: {verb} {rel.as_posix()}{who}"),
        )

    def remember(
        self, text: str, agent: str = "brain", *, trusted: bool = True
    ) -> dict[str, Any]:
        status = "active" if trusted else "proposed"
        outcome = remember(self.root, text, agent_name=agent, status=status)
        result = self.after_write(f"brain: {outcome.outcome} instruction ({agent})")
        payload = {**outcome.to_dict(), "sync": result.to_dict()}
        if outcome.outcome == "created" and not trusted:
            payload["status"] = "proposed"
            payload["note"] = (
                "filed as a proposal: it applies once a person activates it"
            )
        return payload

    def proposals(self) -> list[dict[str, Any]]:
        """Instructions waiting for a person: what agents proposed."""
        from .memories import instructions

        return [
            i.to_dict()
            for i in instructions(self.root, include_inactive=True)
            if i.status == "proposed"
        ]

    def set_instruction_status(self, rel: str, status: str) -> dict[str, Any]:
        """Activate (``active``) or turn down (``retired``) an instruction."""
        if status not in ("active", "retired"):
            raise ValueError("status is 'active' or 'retired'")
        path = Path(rel)
        if path.parts[0] != KINDS["instruction"] or ".." in path.parts:
            raise ValueError("not an instruction note")
        note = read_note(self.root, path)
        note.meta["status"] = status
        note.meta["updated"] = now_iso()
        write_note(self.root, note)
        result = self.after_write(f"brain: {status} {path.as_posix()}")
        return {"path": path.as_posix(), "status": status, "sync": result.to_dict()}

    # -- read: the recall ladder ------------------------------------------

    def graph(self) -> BrainGraph:
        return BrainGraph.load(self.root)

    def recall(self, query: str, limit: int = 5) -> dict[str, Any]:
        """Levels 1 and 2 of graph-first recall: graph hits, then their frontmatter.

        Level 3 — the body — is `read`, a separate call, because deciding which
        file deserves opening is the whole point of the first two.
        """
        self.before_read()
        hits = self.graph().query(query, limit=limit)
        level = "graph"
        if not hits:
            hits = self._index_search(query, limit)
            level = "index"
        for hit in hits:
            source = hit.get("source_file")
            if source and (self.root / source).is_file():
                meta = read_note(self.root, source).meta
                hit["frontmatter"] = {
                    k: meta[k]
                    for k in (
                        "title",
                        "kind",
                        "status",
                        "tags",
                        "agents",
                        "updated",
                        "description",
                    )
                    if k in meta
                }
        return {
            "query": query,
            "level": level,
            "hits": hits,
            "next": "brain_read_note(path) sur le source_file utile — seulement si ceci ne suffit pas",
        }

    def _index_search(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Fallback: words anywhere in the body, reported as path + matching line only."""
        words = [w for w in re.findall(r"\w+", query.lower()) if len(w) > 1]
        if not words:
            return []
        out = []
        for rel in iter_notes(self.root):
            try:
                text = (self.root / rel).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            low = text.lower()
            if not all(w in low for w in words):
                continue
            line = next(
                (ln.strip() for ln in text.splitlines() if words[0] in ln.lower()), ""
            )
            out.append(
                {
                    "id": rel.as_posix()[:-3],
                    "source_file": rel.as_posix(),
                    "match": line[:200],
                }
            )
            if len(out) >= limit:
                break
        return out

    def read(self, rel: str) -> dict[str, Any]:
        self.before_read()
        path = Path(rel)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("a note path is relative to the brain and stays inside it")
        if path.suffix != ".md":
            path = path.with_suffix(".md")
        note = read_note(self.root, path)
        return {"path": note.rel, "frontmatter": note.meta, "body": note.body}

    def status(self) -> dict[str, Any]:
        counts: dict[str, int] = {}
        for rel in iter_notes(self.root):
            head = rel.parts[0] if len(rel.parts) > 1 else "(root)"
            counts[head] = counts.get(head, 0) + 1
        return {
            "root": str(self.root),
            "exists": self.exists,
            "git": (self.root / ".git").exists(),
            "remote": remote_url(self.root),
            "graph": str(graph_path(self.root)),
            "graphStale": self.graph_is_stale() if self.exists else None,
            "notes": counts,
            "proposals": len(self.proposals()) if self.exists else 0,
            "autoPull": _auto("BRAIN_AUTO_PULL"),
            "autoPush": _auto("BRAIN_AUTO_PUSH"),
        }

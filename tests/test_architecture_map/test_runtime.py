"""The doctor: where archify is, and what it says when it is not there."""

from __future__ import annotations

from pathlib import Path

from architecture_visualizer.archify import runtime


class TestArchifyRoot:
    def test_finds_the_vendored_tree(self):
        root = runtime.archify_root()
        assert root is not None, "the vendored renderer should be in the repository"
        assert (root / "bin" / "archify.mjs").is_file()

    def test_env_override_wins(self, tmp_path: Path, monkeypatch):
        """A developer moving the pin points at a clone without touching vendor/."""
        fake = tmp_path / "clone"
        (fake / "bin").mkdir(parents=True)
        (fake / "bin" / "archify.mjs").write_text("", encoding="utf-8")
        monkeypatch.setenv("WORKPILOT_ARCHIFY_HOME", str(fake))
        assert runtime.archify_root() == fake

    def test_a_bogus_override_falls_back_rather_than_failing(
        self, tmp_path: Path, monkeypatch
    ):
        """An override pointing nowhere must not disable a working install."""
        monkeypatch.setenv("WORKPILOT_ARCHIFY_HOME", str(tmp_path / "nope"))
        root = runtime.archify_root()
        assert root is not None
        assert (root / "bin" / "archify.mjs").is_file()


class TestCheck:
    def test_reports_ready_in_this_checkout(self):
        readiness = runtime.check()
        assert readiness.ok, [c.detail for c in readiness.blockers]
        assert readiness.node
        assert readiness.archify_root

    def test_always_reports_every_condition(self):
        """Not just the first failure.

        Reporting one at a time means fixing it reveals the next, one
        round-trip each; the card shows the list.
        """
        names = {c.name for c in runtime.check().conditions}
        assert names == {"node", "runtime"}

    def test_a_missing_runtime_is_blocking_and_names_its_remedy(
        self, tmp_path: Path, monkeypatch
    ):
        monkeypatch.setattr(runtime, "_VENDORED", tmp_path / "absent")
        monkeypatch.delenv("WORKPILOT_ARCHIFY_HOME", raising=False)
        readiness = runtime.check()
        assert not readiness.ok
        blocker = next(c for c in readiness.blockers if c.name == "runtime")
        assert "vendor_archify.py" in blocker.remedy

    def test_a_missing_node_is_blocking_and_names_its_remedy(self, monkeypatch):
        monkeypatch.setattr(runtime, "find_executable", lambda _name: None)
        readiness = runtime.check()
        assert not readiness.ok
        blocker = next(c for c in readiness.blockers if c.name == "node")
        assert "Node.js" in blocker.remedy

    def test_an_old_node_is_refused_with_its_version(self, monkeypatch):
        monkeypatch.setattr(runtime, "find_executable", lambda _name: "/usr/bin/node")
        monkeypatch.setattr(runtime, "_node_version", lambda _n: (False, "v16.20.0"))
        readiness = runtime.check()
        assert not readiness.ok
        blocker = next(c for c in readiness.blockers if c.name == "node")
        assert "v16.20.0" in blocker.remedy

    def test_an_unparseable_node_version_is_not_a_refusal(self, monkeypatch):
        """The renderer states its own requirement far better than a regex here."""
        monkeypatch.setattr(runtime, "find_executable", lambda _name: "/usr/bin/node")
        monkeypatch.setattr(runtime, "_node_version", lambda _n: (True, "custom-build"))
        assert runtime.check().ok


class TestTreeDigest:
    """The digest must depend on the files, and on nothing about the machine.

    The regression: `file_digests` sorted `Path` objects. `PurePath` comparison
    goes through `_str_normcase`, which is lowercased on Windows, so the same
    byte-identical tree folded into a different order there — the Linux receipt
    said `570ef3c6…` and the Windows runner computed `827c274b…`. Every file
    matched; only the order the hash saw them in did not.

    That is invisible to a suite running on one platform, which is why the
    ordering rule is pinned here rather than left to whichever sort the
    implementation happens to call.
    """

    @staticmethod
    def _tree(root: Path) -> None:
        """Names whose ASCII order and case-insensitive order disagree.

        posix:            `Beta/gamma.mjs`, `Zebra.md`, `alpha.md`
        case-insensitive: `alpha.md`, `Beta/gamma.mjs`, `Zebra.md`
        """
        (root / "Beta").mkdir(parents=True)
        (root / "Beta" / "gamma.mjs").write_text("gamma\n", encoding="utf-8")
        (root / "Zebra.md").write_text("zebra\n", encoding="utf-8")
        (root / "alpha.md").write_text("alpha\n", encoding="utf-8")

    def test_files_are_ordered_by_their_posix_path(self, tmp_path: Path):
        self._tree(tmp_path)
        keys = list(runtime.file_digests(tmp_path))
        assert keys == ["Beta/gamma.mjs", "Zebra.md", "alpha.md"]
        # Not the order a case-insensitive sort would give — the one that
        # produced two different digests for one tree.
        assert keys != sorted(keys, key=str.lower)

    def test_the_digest_is_the_posix_ordered_fold(self, tmp_path: Path):
        """Recomputed independently of how the implementation walks the tree."""
        import hashlib

        self._tree(tmp_path)
        expected = hashlib.sha256()
        for relative in ["Beta/gamma.mjs", "Zebra.md", "alpha.md"]:
            content = (tmp_path / relative).read_bytes()
            expected.update(
                f"{hashlib.sha256(content).hexdigest()}  {relative}\n".encode()
            )
        assert runtime.tree_digest(tmp_path) == expected.hexdigest()

    def test_the_receipt_is_not_part_of_what_it_attests_to(self, tmp_path: Path):
        self._tree(tmp_path)
        before = runtime.tree_digest(tmp_path)
        (tmp_path / runtime.RECEIPT_NAME).write_text("{}", encoding="utf-8")
        assert runtime.tree_digest(tmp_path) == before
        assert runtime.RECEIPT_NAME not in runtime.file_digests(tmp_path)

    def test_content_and_path_both_move_the_digest(self, tmp_path: Path):
        self._tree(tmp_path)
        before = runtime.tree_digest(tmp_path)

        (tmp_path / "alpha.md").write_text("alpha!\n", encoding="utf-8")
        assert runtime.tree_digest(tmp_path) != before

        (tmp_path / "alpha.md").write_text("alpha\n", encoding="utf-8")
        assert runtime.tree_digest(tmp_path) == before

        # A rename with identical bytes still moves it: the path is hashed too.
        (tmp_path / "alpha.md").rename(tmp_path / "alpha2.md")
        assert runtime.tree_digest(tmp_path) != before

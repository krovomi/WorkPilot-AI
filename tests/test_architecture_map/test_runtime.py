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

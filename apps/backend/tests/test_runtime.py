"""Tests for runtime environment checks and configuration."""

from architecture_visualizer.archify import runtime


class TestRuntimeChecks:
    """Tests for runtime environment readiness checks."""

    def test_all_dependencies_available(self, monkeypatch):
        """Test when all required dependencies are present."""
        monkeypatch.setattr(runtime, "find_executable", lambda _name: "/usr/bin/node")
        monkeypatch.setattr(runtime, "_node_version", lambda _n: (True, "v18.0.0"))
        assert runtime.check().ok

    def test_node_not_found(self, monkeypatch):
        """Test when Node.js is not available."""
        monkeypatch.setattr(runtime, "find_executable", lambda _name: None)
        readiness = runtime.check()
        assert not readiness.ok
        assert any("node" in b.name for b in readiness.blockers)

    def test_incompatible_node_version(self, monkeypatch):
        """Test when Node.js version is incompatible."""
        monkeypatch.setattr(runtime, "find_executable", lambda _name: "/usr/bin/node")
        monkeypatch.setattr(runtime, "_node_version", lambda _n: (False, "v12.0.0"))
        readiness = runtime.check()
        assert not readiness.ok

    def test_an_unparseable_node_version_is_not_a_refusal(self, monkeypatch):
        """The renderer states its own requirement far better than a regex here."""
        monkeypatch.setattr(runtime, "find_executable", lambda _name: "/usr/bin/node")
        monkeypatch.setattr(runtime, "_node_version", lambda _n: (True, "custom-build"))
        assert runtime.check().ok

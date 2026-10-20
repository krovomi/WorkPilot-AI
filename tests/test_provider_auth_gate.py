"""The Claude OAuth token is only demanded of builds that run on Claude.

The CLI used to gate every build on `get_auth_token()`. A user who picked
Ollama in the UI got the task accepted by the frontend — which asks the same
question and answers it correctly — and refused by the backend one second
later, told to run `claude setup-token` for a service the build never talks to.

The second half of these tests pins the other defect the same failure exposed:
`sys.exit(1)` raises SystemExit, which the build's `except Exception` never
sees, so a cause that was known in full went to the card as "exited
unexpectedly with code 1".
"""

import pytest
from core.auth import provider_requires_claude_oauth


class TestProviderRequiresClaudeOauth:
    @pytest.mark.parametrize(
        "provider", ["claude", "anthropic", "Claude", " ANTHROPIC "]
    )
    def test_claude_providers_need_the_token(self, provider):
        assert provider_requires_claude_oauth(provider) is True

    @pytest.mark.parametrize(
        "provider",
        [
            "ollama",
            "lmstudio",
            "local",
            "openai",
            "google",
            "mistral",
            "copilot",
            "windsurf",
        ],
    )
    def test_every_other_provider_brings_its_own_credential(self, provider):
        assert provider_requires_claude_oauth(provider) is False

    @pytest.mark.parametrize("provider", [None, "", "   "])
    def test_an_unset_provider_means_the_default_which_is_claude(self, provider):
        """Silence must not become a way to skip the check."""
        assert provider_requires_claude_oauth(provider) is True


class TestValidateEnvironment:
    """`validate_environment` reports *which* prerequisite blocked the build."""

    @pytest.fixture
    def spec_dir(self, tmp_path):
        d = tmp_path / "003-feature"
        d.mkdir()
        (d / "spec.md").write_text("# Spec\n", encoding="utf-8")
        return d

    def test_ollama_build_starts_without_a_claude_token(self, spec_dir, monkeypatch):
        """The regression this whole change exists for."""
        from cli import utils

        monkeypatch.setattr(utils, "validate_platform_dependencies", lambda: None)
        monkeypatch.setattr(utils, "get_auth_token", lambda: None)
        monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "ollama")

        problems: list[str] = []
        assert utils.validate_environment(spec_dir, problems=problems) is True
        assert problems == []

    def test_claude_build_without_a_token_says_so(self, spec_dir, monkeypatch):
        from cli import utils

        monkeypatch.setattr(utils, "validate_platform_dependencies", lambda: None)
        monkeypatch.setattr(utils, "get_auth_token", lambda: None)
        monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "claude")

        problems: list[str] = []
        assert utils.validate_environment(spec_dir, problems=problems) is False
        assert len(problems) == 1
        assert "claude setup-token" in problems[0]

    def test_a_missing_spec_is_named_too(self, tmp_path, monkeypatch):
        from cli import utils

        empty = tmp_path / "004-no-spec"
        empty.mkdir()
        monkeypatch.setattr(utils, "validate_platform_dependencies", lambda: None)
        monkeypatch.setattr(utils, "get_auth_token", lambda: "token")
        monkeypatch.setattr(utils, "get_auth_token_source", lambda: "keychain")
        monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "claude")

        problems: list[str] = []
        assert utils.validate_environment(empty, problems=problems) is False
        assert any("spec.md" in problem for problem in problems)

    def test_the_out_parameter_stays_optional(self, spec_dir, monkeypatch):
        """Four call sites and a stubbing test rely on the bool-only contract."""
        from cli import utils

        monkeypatch.setattr(utils, "validate_platform_dependencies", lambda: None)
        monkeypatch.setattr(utils, "get_auth_token", lambda: None)
        monkeypatch.setattr(utils, "_active_provider", lambda _spec_dir: "ollama")

        assert utils.validate_environment(spec_dir) is True


class TestActiveProviderResolution:
    """Resolution is read-only: a validator must not eat a single-shot choice."""

    def test_it_falls_back_to_the_frontend_env_signal(self, tmp_path, monkeypatch):
        from cli import utils

        monkeypatch.setenv("SELECTED_LLM_PROVIDER", "ollama")
        # Simulate `core.client` being unimportable — the fallback must not
        # answer "claude" and blame the wrong thing.
        import builtins

        real_import = builtins.__import__

        def explode(name, *args, **kwargs):
            if name == "core.client":
                raise ImportError("boom")
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", explode)
        assert utils._active_provider(tmp_path) == "ollama"

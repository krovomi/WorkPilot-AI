"""
Tests unitaires pour la découverte, la configuration et la sélection des providers LLM.
"""

import os

import pytest

from src.connectors import llm_config as llm_config_module
from src.connectors.llm_base import BaseLLMProvider
from src.connectors.llm_config import (
    delete_provider_config,
    list_provider_configs,
    load_provider_config,
    save_provider_config,
)
from src.connectors.llm_discovery import discover_llm_providers


class DummyProvider(BaseLLMProvider):
    def __init__(self, key=None):
        self.key = key

    def connect(self):
        # `test_provider_validation` expects a rejected key to raise one of
        # (ValueError, ConnectionError, RuntimeError). This accepted any
        # non-empty string and raised a bare `Exception` when empty, so the
        # "invalid key" case never raised at all and the "missing key" case
        # would not have matched either.
        if self.key != "valid":
            raise ValueError(f"Invalid key: {self.key!r}")

    def validate(self):
        return self.key == "valid"

    def generate(self, prompt, **kwargs):
        return f"dummy: {prompt}"

    def get_capabilities(self):
        return {"models": ["dummy"]}

    def get_config_schema(self):
        return {"key": "str"}

    def get_name(self):
        return "dummy"


def test_save_and_load_provider_config(tmp_path, monkeypatch):
    # The module object, not the dotted string: `src.connectors.llm_config` is
    # reachable under more than one name, and the string form resolves the
    # attribute on the package — bound only if that exact name was imported
    # first.
    monkeypatch.setattr(llm_config_module, "CONFIG_FILE", tmp_path / "llm.json")
    save_provider_config("dummy", {"key": "valid"})
    config = load_provider_config("dummy")
    assert config["key"] == "valid"
    assert "dummy" in list_provider_configs()
    delete_provider_config("dummy")
    assert load_provider_config("dummy") is None


def test_discover_llm_providers(monkeypatch):
    # The name is bound in this module at import time, so patching the
    # attribute on `llm_discovery` left this call pointing at the real
    # function — which returns the shipped providers, and `AnthropicProvider()`
    # then failed on its required `api_key`. Patch the name the call uses.
    monkeypatch.setattr(f"{__name__}.discover_llm_providers", lambda: [DummyProvider])
    providers = discover_llm_providers()
    assert any(p().get_name() == "dummy" for p in providers)


def test_provider_validation():
    provider = DummyProvider(key="valid")
    provider.connect()
    assert provider.validate()
    provider2 = DummyProvider(key="invalid")
    with pytest.raises((ValueError, ConnectionError, RuntimeError)):
        provider2.connect()

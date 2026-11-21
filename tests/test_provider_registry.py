"""The static provider catalogue the phone's New card screen offers."""

from services.provider_registry import ProviderRegistry, provider_registry


def test_each_provider_names_its_models_with_a_value_and_a_label():
    providers = provider_registry.get_all_providers()

    assert providers
    for provider in providers:
        assert provider["name"] and provider["label"]
        assert provider["models"], provider["name"]
        for model in provider["models"]:
            assert model["value"] and model["label"], (provider["name"], model)


def test_the_catalogue_is_the_same_each_time_it_is_built():
    names = [p["name"] for p in provider_registry.get_all_providers()]

    assert len(names) == len(set(names))
    assert [p["name"] for p in ProviderRegistry().get_all_providers()] == names
    assert "anthropic" in names

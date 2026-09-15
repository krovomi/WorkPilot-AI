"""Offline dashboard regression tests (also runnable with unittest)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "backend"))
from core import offline_policy

from runners import offline_mode_runner as runner


class OfflineModeTests(unittest.TestCase):
    def test_strict_mode_blocks_cloud_clients_in_nested_worktree(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".workpilot").mkdir()
            (root / ".workpilot/offline-mode.json").write_text(
                json.dumps({"airgapStrict": True, "routing": {}}), encoding="utf-8"
            )
            with self.assertRaises(ValueError):
                offline_policy.guard_cloud_client(root / "nested")
            with self.assertRaises(ValueError):
                offline_policy.resolve_offline_route(
                    root, root, "coder", "openai", "gpt-5"
                )

    def test_runtime_endpoints_are_distinct_and_cannot_be_remote(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(
                offline_policy.local_endpoint("lm-studio"), "http://127.0.0.1:1234"
            )
            self.assertEqual(
                offline_policy.local_endpoint("llama-cpp"), "http://127.0.0.1:8080"
            )
        with patch.dict("os.environ", {"OLLAMA_BASE_URL": "https://example.com"}):
            with self.assertRaises(ValueError):
                offline_policy.local_endpoint("ollama")

    def test_uninstalled_model_is_rejected_at_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".workpilot").mkdir()
            (root / ".workpilot/offline-mode.json").write_text(
                json.dumps(
                    {
                        "airgapStrict": True,
                        "routing": {
                            "coder": {"provider": "ollama", "model": "missing:7b"}
                        },
                    }
                ),
                encoding="utf-8",
            )
            with patch(
                "core.local_model_catalog.detect_runtime",
                return_value={"available": True, "models": []},
            ):
                with self.assertRaises(ValueError):
                    offline_policy.resolve_offline_route(
                        root, root, "coder", "claude", "claude"
                    )

    def test_oneshot_routes_to_lm_studio_without_cloud_fallback(self):
        from core.oneshot import _build_client

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".workpilot").mkdir()
            (root / ".workpilot/offline-mode.json").write_text(
                json.dumps(
                    {
                        "airgapStrict": True,
                        "defaultProvider": "lm-studio",
                        "routing": {
                            "commit_message": {
                                "provider": "lm-studio",
                                "model": "my-model",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch(
                    "core.local_model_catalog.detect_runtime",
                    return_value={
                        "available": True,
                        "models": [{"name": "my-model"}],
                    },
                ),
                patch.dict(
                    "os.environ", {"LMSTUDIO_BASE_URL": "http://127.0.0.1:1234"}
                ),
            ):
                client = _build_client("openai", "gpt-5", None, directory, directory, 1)
            self.assertEqual(client.model, "my-model")
            self.assertEqual(
                client._api_base, "http://127.0.0.1:1234/v1/chat/completions"
            )
            self.assertEqual(client._api_format, "openai")
            self.assertTrue(client._offline_only)

    def test_strict_unlisted_phase_uses_selected_local_default(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".workpilot").mkdir()
            (root / ".workpilot/offline-mode.json").write_text(
                json.dumps(
                    {
                        "airgapStrict": True,
                        "defaultProvider": "ollama",
                        "routing": {
                            "coder": {"provider": "ollama", "model": "qwen:7b"}
                        },
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch(
                    "core.local_model_catalog.detect_runtime",
                    return_value={
                        "available": True,
                        "models": [{"name": "qwen:7b"}],
                    },
                ),
                patch.dict("os.environ", {"OLLAMA_BASE_URL": "http://127.0.0.1:11434"}),
            ):
                provider, model, endpoint = offline_policy.resolve_offline_route(
                    root, root, "spec", "claude", "claude"
                )
            self.assertEqual(
                (provider, model, endpoint),
                ("ollama", "qwen:7b", "http://127.0.0.1:11434"),
            )

    def test_no_policy_preserves_existing_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(
                offline_policy.resolve_offline_route(
                    root, root, "coder", "openai", "gpt-5"
                ),
                ("openai", "gpt-5", None),
            )

    def test_offline_client_does_not_download_missing_models(self):
        import asyncio

        from core.agent_client import LocalAgentClient

        async def collect():
            client = LocalAgentClient(model="missing", offline_only=True)
            return [entry async for entry in client._pull_ollama_model_stream()]

        self.assertEqual(
            asyncio.run(collect()),
            [("error", "Offline mode blocks automatic model downloads")],
        )

    def test_discovery_uses_server_ids_and_excludes_cloud_and_embeddings(self):
        import io
        from unittest.mock import MagicMock

        from core.local_model_catalog import detect_runtime

        opener = MagicMock()
        opener.open.return_value = io.BytesIO(
            json.dumps(
                {
                    "models": [
                        {"name": "qwen:7b"},
                        {"name": "nomic-embed-text:latest"},
                        {"name": "gpt-oss:120b-cloud"},
                        {"name": "remote", "remote_host": "cloud.example"},
                    ]
                }
            ).encode()
        )
        with (
            patch("core.local_model_catalog.build_opener", return_value=opener),
            patch.dict("os.environ", {"OLLAMA_BASE_URL": "http://127.0.0.1:11434"}),
        ):
            runtime = detect_runtime("ollama")
        self.assertEqual([m["name"] for m in runtime["models"]], ["qwen:7b"])
        opener.open.assert_called_once_with(
            "http://127.0.0.1:11434/api/tags", timeout=3
        )

    def test_old_cloud_catalog_cache_is_discarded(self):
        from datetime import datetime, timezone

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = runner._cache_path(root)
            cache.parent.mkdir()
            cache.write_text(
                json.dumps(
                    {
                        "cachedAt": datetime.now(timezone.utc).isoformat(),
                        "providers": {"anthropic": ["claude"]},
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(
                    runner, "_detect_ollama", return_value={"available": False}
                ),
                patch.object(
                    runner, "_detect_lm_studio", return_value={"available": False}
                ),
                patch.object(
                    runner, "_detect_llama_cpp", return_value={"available": False}
                ),
            ):
                result = runner._scan_models(root)
            self.assertNotIn("anthropic", result["providers"])
            self.assertFalse(result["fromCache"])

    def test_strict_client_skips_mcp_connections(self):
        import asyncio

        from core.agent_client import LocalAgentClient

        async def enter():
            client = LocalAgentClient(model="qwen:7b", offline_only=True)
            with patch("builtins.__import__", wraps=__import__) as imports:
                await client.__aenter__()
                self.assertFalse(
                    any(
                        call.args[0] == "core.mcp_tools"
                        for call in imports.call_args_list
                    )
                )
            await client.__aexit__(None, None, None)

        asyncio.run(enter())

    def test_can_disable_strict_with_server_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy = {
                "airgapStrict": True,
                "defaultProvider": "ollama",
                "routing": {"coder": {"provider": "ollama", "model": "missing"}},
            }
            runner._policy_path(root).parent.mkdir()
            runner._policy_path(root).write_text(json.dumps(policy), encoding="utf-8")
            policy["airgapStrict"] = False
            with patch.object(
                runner,
                "_scan_models",
                side_effect=AssertionError("Must not require an online server"),
            ):
                runner._save_policy(root, policy)
            self.assertFalse(runner._load_policy(root)["airgapStrict"])

    def test_strict_default_requires_an_associated_model(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "default local provider"):
                runner._save_policy(
                    Path(directory),
                    {
                        "airgapStrict": True,
                        "defaultProvider": "lm-studio",
                        "routing": {
                            "coder": {"provider": "ollama", "model": "qwen:7b"}
                        },
                    },
                )

    def test_lm_studio_uses_openai_protocol(self):
        import asyncio

        from core.agent_client import LocalAgentClient, OpenAIAgentClient

        async def response(client):
            yield "local response"

        async def collect():
            client = LocalAgentClient(
                model="local-model",
                base_url="http://127.0.0.1:1234",
                api_format="openai",
            )
            with patch.object(OpenAIAgentClient, "receive_response", response):
                return [message async for message in client.receive_response()]

        self.assertEqual(asyncio.run(collect()), ["local response"])

    def test_catalog_only_contains_real_local_generation_models(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(
                    runner,
                    "_detect_ollama",
                    return_value={
                        "available": True,
                        "models": [
                            {"name": "qwen2.5-coder:7b"},
                            {"name": "nomic-embed-text:latest"},
                        ],
                    },
                ),
                patch.object(
                    runner, "_detect_lm_studio", return_value={"available": False}
                ),
                patch.object(
                    runner, "_detect_llama_cpp", return_value={"available": False}
                ),
            ):
                catalog = runner._scan_models(Path(directory), force=True)
            self.assertEqual(
                catalog["providers"],
                {
                    "ollama": ["qwen2.5-coder:7b"],
                    "lm-studio": [],
                    "llama-cpp": [],
                },
            )

    def test_new_policy_uses_detected_models(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(
                runner,
                "_scan_models",
                return_value={
                    "providers": {"ollama": ["qwen2.5-coder:7b"]},
                },
            ):
                policy = runner._load_policy(Path(directory))
            self.assertTrue(policy["airgapStrict"])
            self.assertTrue(
                all(
                    entry
                    == {
                        "provider": "ollama",
                        "model": "qwen2.5-coder:7b",
                    }
                    for entry in policy["routing"].values()
                )
            )

    def test_save_rejects_cloud_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                runner._save_policy(
                    Path(directory),
                    {
                        "airgapStrict": True,
                        "defaultProvider": "anthropic",
                        "routing": {
                            "coder": {"provider": "anthropic", "model": "claude"}
                        },
                    },
                )
            self.assertFalse(runner._policy_path(Path(directory)).exists())


if __name__ == "__main__":
    unittest.main()

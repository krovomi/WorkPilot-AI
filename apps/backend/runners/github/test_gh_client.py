"""
Tests for GHClient timeout and retry functionality.
"""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from gh_client import GHClient, GHCommandError, GHTimeoutError


class TestGHClient:
    """Test suite for GHClient."""

    @pytest.fixture
    def client(self, tmp_path):
        """Create a test client."""
        return GHClient(
            project_dir=tmp_path,
            default_timeout=2.0,
            max_retries=3,
        )

    @pytest.mark.asyncio
    async def test_timeout_raises_error(self, client):
        """Test that commands timeout after max retries.

        This used to shell out to the real `gh` against a real repository, so
        it needed the CLI installed and the network reachable — and on a machine
        without `gh` it raised `GHCommandError: not found` long before any
        timeout. The retry-then-give-up logic is what the test is for, so the
        subprocess is simulated here, on the pattern
        `TestGHClientGhExecutableDetection` already uses below.
        """

        async def _never_returns(*_args, **_kwargs):
            await asyncio.sleep(10)

        mock_proc = MagicMock()
        mock_proc.communicate = _never_returns
        mock_proc.returncode = None

        with patch("gh_client.get_gh_executable", return_value="/usr/bin/gh"):
            with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
                with pytest.raises(GHTimeoutError) as exc_info:
                    await client.run(["api", "/repos/nonexistent/repo"], timeout=0.1)

        assert "timed out after 3 attempts" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_invalid_command_raises_error(self, client):
        """Test that invalid commands raise GHCommandError."""
        with pytest.raises(GHCommandError):
            await client.run(["invalid-command"])

    @pytest.mark.asyncio
    async def test_successful_command(self, client):
        """Test successful command execution."""
        # This test requires gh CLI to be installed
        try:
            result = await client.run(["--version"])
            assert result.returncode == 0
            assert "gh version" in result.stdout
            assert result.attempts == 1
        except Exception:
            pytest.skip("gh CLI not available")

    @pytest.mark.asyncio
    async def test_convenience_methods_timeout_protection(self, client):
        """Test that convenience methods have timeout protection."""
        # These will fail because repo doesn't exist, but should not hang
        with pytest.raises((GHCommandError, GHTimeoutError)):
            await client.pr_list()

        with pytest.raises((GHCommandError, GHTimeoutError)):
            await client.issue_list()


class TestGHClientGhExecutableDetection:
    """Test suite for GHClient gh executable detection."""

    @pytest.fixture
    def client(self, tmp_path):
        """Create a test client."""
        return GHClient(
            project_dir=tmp_path,
            default_timeout=2.0,
            max_retries=3,
        )

    @pytest.mark.asyncio
    async def test_run_raises_error_when_gh_not_found(self, client):
        """Test that run() raises GHCommandError when gh is not found."""
        with patch("gh_client.get_gh_executable", return_value=None):
            with pytest.raises(GHCommandError) as exc_info:
                await client.run(["--version"])

            assert "not found" in str(exc_info.value)
            # Test verifies error message mentions GitHub CLI for user guidance
            assert "GitHub CLI" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_run_uses_detected_gh_executable(self, client):
        """Test that run() uses the detected gh executable path."""
        mock_exec = "/custom/path/to/gh"

        with patch("gh_client.get_gh_executable", return_value=mock_exec):
            with patch("asyncio.create_subprocess_exec") as mock_subprocess:
                # Mock the subprocess to return immediately
                mock_proc = MagicMock()
                mock_proc.communicate = AsyncMock(
                    return_value=(b"gh version 2.0.0\n", b"")
                )
                mock_proc.returncode = 0
                mock_subprocess.return_value = mock_proc

                await client.run(["--version"])

                # Verify the correct gh path was used
                mock_subprocess.assert_called_once()
                called_cmd = mock_subprocess.call_args[0][0]
                assert called_cmd == mock_exec


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

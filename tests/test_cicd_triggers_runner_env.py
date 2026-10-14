"""The CI/CD triggers runner's environment: the process environment wins.

The desktop app keeps the CI/CD settings encrypted in `.workpilot/.env` and
passes them decrypted as environment variables. The project's root `.env`
belongs to the user's application; a stale `CICD_*` value there must not
override what the app passed.
"""

from runners.cicd_triggers_runner import load_env


def test_environment_wins_over_the_root_env(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        "CICD_GITHUB_TOKEN=stale-value\nCICD_GITHUB_REF=dev\n", encoding="utf-8"
    )
    monkeypatch.setenv("CICD_GITHUB_TOKEN", "from-the-app")
    monkeypatch.delenv("CICD_GITHUB_REF", raising=False)

    env = load_env(str(tmp_path))

    assert env["CICD_GITHUB_TOKEN"] == "from-the-app"
    assert env["CICD_GITHUB_REF"] == "dev"


def test_no_root_env_is_the_process_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("CICD_PROVIDER", "gitlab")

    assert load_env(str(tmp_path))["CICD_PROVIDER"] == "gitlab"

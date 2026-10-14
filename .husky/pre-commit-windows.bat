@echo off
REM Windows pre-commit hook for automatic code formatting

echo 🔐 Scanning staged files for secrets...
REM Python: the venv's, in the places findVenvBin looks (scripts/lib/test-selection.js),
REM else the one on PATH. Missing Python warns; a secret found blocks the commit.
set "PYTHON="
for %%P in (apps\backend\.venv\Scripts\python.exe .venv\Scripts\python.exe .cache\.venv\Scripts\python.exe python) do (
    if not defined PYTHON (
        %%P -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
        if not errorlevel 1 set "PYTHON=%%P"
    )
)
if not defined PYTHON (
    echo ⚠ Python 3.10+ not found - secret scan skipped. Review git diff --cached before committing.
) else (
    "%PYTHON%" apps\backend\security\scan_secrets.py --staged-only --quiet
    if errorlevel 1 (
        echo ❌ Commit blocked: potential secret in staged files, see above.
        echo    Move the value out of the file ^(.env-files\*.env, environment variable^), then git add.
        echo    False positive: end the line with "# pragma: allowlist secret", or add a regex to .secretsignore.
        exit /b 1
    )
)

echo 🔧 Running ruff format on backend...
python -m ruff format apps/backend/
if errorlevel 1 (
    echo ❌ Ruff format failed
    exit /b 1
)

echo 🔧 Running ruff check on backend...
python -m ruff check --fix --exit-non-zero-on-fix apps/backend/
if errorlevel 1 (
    echo ❌ Ruff check failed
    exit /b 1
)

echo 🔧 Running frontend lint and typecheck...
cd apps/frontend
call pnpm lint
if errorlevel 1 (
    echo ❌ Frontend lint failed
    exit /b 1
)

call pnpm typecheck
if errorlevel 1 (
    echo ❌ Frontend typecheck failed
    exit /b 1
)

echo ✅ All pre-commit checks passed!

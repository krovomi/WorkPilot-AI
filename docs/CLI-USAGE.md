# WorkPilot AI CLI Usage

This document covers terminal-only usage of WorkPilot AI. **For most users, we recommend using the [Desktop UI](../README.md#download) instead** - it provides a better experience with visual task management, progress tracking, and automatic Python environment setup.

## When to Use CLI

- You prefer terminal workflows
- You're running on a headless server
- You're integrating WorkPilot AI into scripts or CI/CD

## Prerequisites

- Python 3.12+ (`run.py` refuses to start on an older version)
- For the Claude provider, the Claude Code CLI: `curl -fsSL https://claude.ai/install.sh | bash`
  (macOS, Linux, WSL) or `irm https://claude.ai/install.ps1 | iex` (PowerShell). Other providers
  need only their key or their own CLI (see [CONFIGURATION.md](CONFIGURATION.md#provider-selection-and-endpoints)).

### Installing Python

**Windows:**
```bash
winget install Python.Python.3.12
```

**macOS:**
```bash
brew install python@3.12
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt install python3.12 python3.12-venv
```

**Linux (Fedora):**
```bash
sudo dnf install python3.12
```

## Setup

**Step 1:** Navigate to the backend directory

```bash
cd apps/backend
```

**Step 2:** Set up Python environment

```bash
# From the repository root: creates apps/backend/.venv and installs the lock + test dependencies
pnpm run install:backend

# Or by hand, from apps/backend (requirements.lock pins what CI tests)
uv venv && uv pip install -r requirements.lock
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.lock
```

**Step 3:** Configure environment

`run.py` reads `.env-files/.env` at the **repository root** (not under `apps/backend/`). Create it
there; `.env-files/.env.example` lists optional settings (Azure DevOps, Copilot budgets…).

```bash
# From the repository root
touch .env-files/.env

# Claude: sign in once (`claude`, then `/login`; the token is read from the OS keychain),
# or get a long-lived token and put it in .env-files/.env:
claude setup-token
# CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

## Creating Specs

All commands below should be run from the `apps/backend/` directory:

```bash
# Activate the virtual environment (if not already active)
source .venv/bin/activate

# Create a spec interactively
python runners/spec_runner.py --interactive

# Or with a task description
python runners/spec_runner.py --task "Add user authentication with OAuth"

# Force a specific complexity level
python runners/spec_runner.py --task "Fix button color" --complexity simple

# Continue an interrupted spec
python runners/spec_runner.py --continue 001-feature
```

### Complexity Tiers

The spec runner automatically assesses task complexity:

| Tier | Phases | When Used |
|------|--------|-----------|
| **SIMPLE** | 4: discovery, historical context, quick spec, validation | 1-2 files, single service, no integrations (UI fixes, text changes) |
| **STANDARD** | 7 (8 with research): discovery, historical context, requirements, context, spec writing, planning, validation | 3-10 files, 1-2 services, minimal integrations (features, bug fixes) |
| **COMPLEX** | 9: the standard set plus research and self-critique | 10+ files, multiple services, external integrations |

The historical context phase reads the shared brain and is skipped when memory is off. Phase
lists: `apps/backend/spec/complexity.py`.

## Running Builds

```bash
# List all specs and their status
python run.py --list

# Run a specific spec
python run.py --spec 001
python run.py --spec 001-feature-name

# Limit iterations for testing
python run.py --spec 001 --max-iterations 5
```

## QA Validation

After all chunks are complete, QA validation runs automatically:

```bash
# Skip automatic QA
python run.py --spec 001 --skip-qa

# Run QA validation manually
python run.py --spec 001 --qa

# Check QA status
python run.py --spec 001 --qa-status
```

The QA validation loop:
1. **QA Reviewer** checks all acceptance criteria
2. If issues found → creates `QA_FIX_REQUEST.md`
3. **QA Fixer** applies fixes
4. Loop repeats until approved, within a budget set by the QA phase's effort:
   3 passes at `none`, 5 at `low`, 8 at `medium`, 12 at `high`, 20 at
   `ultrathink` (`WORKPILOT_QA_MAX_ITERATIONS` overrides it, up to 50). An issue
   that keeps coming back escalates to a human (`QA_ESCALATION.md`) before the
   budget runs out; feedback a person writes opens a new budget.

## Workspace Management

WorkPilot AI uses Git worktrees for isolated builds, one per spec under
`.workpilot/worktrees/tasks/<spec>/` in your project:

```bash
# Test the feature in the isolated workspace
cd <your-project>/.workpilot/worktrees/tasks/001-feature-name/
npm run dev  # or your project's run command: dotnet run, go run ., cargo run, flutter run…

# Return to backend directory to run management commands
cd apps/backend

# See what was changed
python run.py --spec 001 --review

# Merge changes into your project
python run.py --spec 001 --merge

# Discard if you don't like it
python run.py --spec 001 --discard
```

## Steering a Running Task

Send the agent a message without pausing it. It reaches the prompt of the next
coding or QA fixer session, and the task shows which session received it:

```bash
python run.py --spec 001 --steer "Keep the old route, add the new one beside it"

# Only for one subtask's next session
python run.py --spec 001 --steer "Log the retries" --steer-subtask subtask-2-1
```

## Interactive Controls

While the agent is running:

```bash
# Pause and add instructions
Ctrl+C (once)

# Exit immediately
Ctrl+C (twice)
```

**File-based alternative:**
```bash
# Create PAUSE file to pause after current session
touch .workpilot/specs/001-name/PAUSE

# Add instructions
echo "Focus on fixing the login bug first" > .workpilot/specs/001-name/HUMAN_INPUT.md
```

The next subtask session receives the instructions first in its prompt. Once that session has run,
WorkPilot archives the file as `HUMAN_INPUT.<UTC timestamp>.md`: an instruction applies once, and
the archive keeps its trace. Agents cannot write `HUMAN_INPUT.md`; only you do.

## Spec Validation

```bash
python spec/validate_spec.py --spec-dir <your-project>/.workpilot/specs/001-feature --checkpoint all
```

## Environment Variables

Set them in `.env-files/.env` at the repository root, or in the shell. A variable already set in
the environment is never overwritten by the file. The full list is in
[CONFIGURATION.md](CONFIGURATION.md).

### Core Settings

| Variable | Required | Description |
|----------|----------|-------------|
| `CLAUDE_CODE_OAUTH_TOKEN` | For Claude, unless the keychain has a token | OAuth token from `claude setup-token` |
| `AUTO_CLAUDE_PROVIDER` | No | Default provider (`claude`, `openai`, `copilot`, `google`, `ollama`, `mistral`, `deepseek`, `grok`, `opencode`, `pi`, `gemini-cli`…) |
| `AUTO_BUILD_MODEL` | No | Model for every phase, like `--model`, except the phases the task's metadata sets one for (auto profile). Without it: the task's model, else complexity routing, else the provider's default for the phase (`sonnet` on Claude); see `get_phase_model` in `apps/backend/phase_config.py` |
| `DEFAULT_BRANCH` | No | Base branch for worktrees (auto-detects main/master) |
| `DEBUG` | No | Enable debug logging (default: false) |

### Integrations

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_API_KEY` | No | Linear API key for task sync |
| `GITLAB_TOKEN` | No | GitLab Personal Access Token |
| `GITLAB_INSTANCE_URL` | No | GitLab instance URL (defaults to gitlab.com) |

### Memory (the shared brain)

| Variable | Required | Description |
|----------|----------|-------------|
| `BRAIN_ENABLED` | No | Set to `false` to turn memory off (default: on) |
| `WORKPILOT_BRAIN_DIR` | No | Where the vault lives (default: `~/.workpilot/brain`) |

Provider keys, endpoints and every other variable: [CONFIGURATION.md](CONFIGURATION.md).

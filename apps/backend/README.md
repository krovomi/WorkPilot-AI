# WorkPilot AI Backend

Autonomous coding framework. Builds software features through coordinated multi-agent sessions, and is **provider-agnostic** — drive it with Claude, OpenAI, Gemini, Grok, GitHub Copilot, Azure OpenAI, a local Ollama model, or any OpenAI-compatible endpoint.

## Getting Started

### 1. Install

```bash
cd apps/backend
python -m pip install -r requirements.lock
```

`requirements.lock` holds the exact versions (with hashes, for every platform) that CI tests and the
server image ships; `requirements.txt` holds the ranges it is compiled from. After editing a range,
run `pnpm run lock:python` from the repository root.

### 2. Configure

```bash
cp .env-files/.env.example .env-files/.env
```

Authenticate with Claude Code (token auto-saved to Keychain):
```bash
claude
# Type: /login
# Press Enter to open browser
```

Token is auto-detected from macOS Keychain / Windows Credential Manager.

### 3. Run

```bash
# List available specs
python run.py --list

# Run a spec
python run.py --spec 001
```

## Requirements

- Python 3.12+
- An API key or OAuth login for at least one supported provider (Claude, OpenAI, Gemini, Grok, Copilot, Azure OpenAI, Ollama, or a custom endpoint)

## Commands

| Command | Description |
|---------|-------------|
| `--list` | List all specs |
| `--spec 001` | Run spec 001 |
| `--spec 001 --isolated` | Run in isolated workspace |
| `--spec 001 --direct` | Run directly in repo |
| `--spec 001 --merge` | Merge completed build |
| `--spec 001 --review` | Review build changes |
| `--spec 001 --discard` | Discard build |
| `--spec 001 --qa` | Run QA validation |
| `--list-worktrees` | List all worktrees |
| `--help` | Show all options |

## Configuration

Optional `.env-files/.env` settings:

| Variable | Description |
|----------|-------------|
| `AUTO_BUILD_MODEL` | Override Claude model |
| `DEBUG=true` | Enable debug logging |
| `LINEAR_API_KEY` | Enable Linear integration |
| `BRAIN_ENABLED=false` | Turn memory (the shared brain) off |
| `WORKPILOT_SANDBOX` | `auto` (default), `required` or `off`: run agent commands under bubblewrap / Seatbelt ([os-sandbox.md](../../docs/architecture/os-sandbox.md)) |
| `WORKPILOT_SANDBOX_HOSTS` | Extra hosts a sandboxed command may reach (private registry, mirror) |
| `AUTO_CLAUDE_OTEL_ENDPOINT` | OTLP endpoint; also turns on GenAI spans for every provider ([genai-traces.md](../../docs/architecture/genai-traces.md)) |
| `WORKPILOT_MCP_TASK_TIMEOUT` | Seconds an MCP tool call returned as a task may run before it is cancelled (default 1800) |
| `WORKPILOT_BENCH_CONCURRENCY` | Repo bench builds running at once (default 2, at most 4) |

The complete list is in [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).

## Troubleshooting

**"tree-sitter not available"** - Safe to ignore, uses regex fallback.

**Missing module errors** - Run `python -m pip install -r requirements.txt`

**Debug mode** - Set `DEBUG=true DEBUG_LEVEL=2` before running.

---

## For Developers

### Project Structure

The backend has grown to **90+ specialized modules**. The core pipeline lives in a handful of them; the rest are opt-in subsystems (self-healing, tech debt, carbon profiling, consensus arbitration, multi-user server, etc.).

```
backend/
├── agents/              # AI agent execution (planner, coder, session) + subagents/ registry
├── qa/                  # QA reviewer / fixer validation loop
├── spec/                # Spec creation and management
├── core/                # Composition root: client factory, provider clients (agent_clients/, ACP included), effort plan, auth, worktree
├── foundation/          # Lowest layer, imports nothing back: platform/, api_safety, git, phase events
├── offline_policy/      # airgapStrict: every backend network call asks it first
├── prompts/             # Agent system prompts (~50, incl. github/)
├── skills/              # Token-optimized dynamic skill execution
├── integrations/        # External services (GitHub, GitLab, Azure, Linear, Jira)
├── merge/               # Semantic git merge handling
├── verify/              # Launch the changed app, read its errors, keep a proof (web, mobile, API, Windows UI Automation)
├── pr_followup/         # The card follows its PR: red checks and review threads go to the QA fixer
├── goal/                # Goal mode: a command and its exit code decide when a task is done
├── best_of_n/           # Build a task N ways, rank the builds on numbers
├── bench/               # Repo bench: replay finished cards against hidden tests
├── os_sandbox/          # bubblewrap / Seatbelt around agent commands, filtering proxy
├── genai_trace/         # OpenTelemetry GenAI spans for every AgentClient
├── mcp_tasks/           # MCP 2026-07-28 tasks on WorkPilot's own MCP servers
├── project/             # Project / stack detection
├── context/             # Task context building
├── runners/             # One-shot task runners (insights, oneshot, etc.)
├── streaming/           # Real-time session streaming (WebSocket)
├── task_logger/         # Structured per-phase logging
├── learning/            # Learning mode + documentation generation
├── self_healing/        # Health monitoring + auto-repair
├── tech_debt/           # Technical-debt tracking and resolution
├── consensus_arbiter/   # Reconciles security / QA agent opinions
├── agent_coach/         # Cost/model coaching from real usage
├── carbon_profiler/     # Energy (kWh) / carbon footprint ledger
├── release_coordinator/ # Release readiness orchestration
├── server/              # Multi-user server mode (auth, claims, run manager)
├── cli/                 # Command-line interface
└── ...                  # ~70 more opt-in subsystems
```

### Design Principles

- **SOLID** - Single responsibility, clean interfaces
- **DRY** - Shared utilities in `foundation/`, which imports nothing of the backend; `core/` composes the agents on top of it
- **KISS** - Flat imports from the backend root (`from agents.coder import …`); compatibility shims have been removed

### Import Convention

```python
# Import the real module; the root-level facades are gone
from foundation.debug import debug, debug_error
from core.progress import count_subtasks
from foundation.platform import is_windows
```

`tests/test_import_contracts.py` holds the layers: `foundation`, `security`, `project`,
`offline_policy` and a few more import only what their contract lists, and the largest import
cycle (`MAX_CYCLE`) may only shrink.

### Adding Features

1. Create module in appropriate folder
2. Export API in `__init__.py`
3. A helper that imports nothing of the backend goes in `foundation/`, not `core/`

## Multi-Provider LLM Support

Le backend supporte la sélection dynamique du LLM via l'interface utilisateur ou la configuration du projet.

Providers supportés :
- Anthropic (Claude Opus, Sonnet, Haiku), par le SDK Claude Agent ou le CLI Claude Code
- OpenAI (API et Codex)
- GitHub Copilot
- Google (Gemini API, et Gemini CLI par le client ACP)
- xAI (Grok), Mistral AI, DeepSeek
- Ollama (modèles locaux) et tout endpoint compatible OpenAI
- CLI pi (pi.dev), OpenCode, Antigravity
- Tout agent Agent Client Protocol déclaré par un bloc `acp:` de `capabilities/providers.yaml`

La sélection du provider se fait automatiquement via l'interface utilisateur et est synchronisée avec les agents d'exécution.
Chaque provider reçoit l'effort de raisonnement sur sa propre échelle ; `core/effort_plan.py` dit ce qui
est réellement envoyé, et le sélecteur d'effort l'affiche (`GET /providers/effort`).

## License

AGPL-3.0
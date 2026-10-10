# Developer tools: Electron MCP, Chrome DevTools MCP, grepai

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## E2E Testing (Electron MCP)

QA agents can interact with the running Electron app via Chrome DevTools Protocol:

1. Start app: `pnpm run dev:debug` (debug mode for AI self-validation via Electron MCP)
2. Set `ELECTRON_MCP_ENABLED=true` in `.env-files/.env`
3. Run QA: `python run.py --spec 001 --qa`

Tools: `take_screenshot`, `click_by_text`, `fill_input`, `get_page_structure`, `send_keyboard_shortcut`, `eval`. 

## Chrome DevTools MCP

Browser automation via [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is available for **coder** and **QA** agents. It provides 29 tools for navigation, input, screenshots, debugging, emulation, and network inspection.

**Enable:** Toggle "Chrome DevTools" in project Settings → Agent Tools → MCP Servers, or set `CHROME_DEVTOOLS_MCP_ENABLED=true` in `.env-files/.env`.

**Optional:** Set `CHROME_DEVTOOLS_PORT=9222` to connect to a running Chrome instance (e.g., the app emulator). Without it, agents launch a headless Chrome.

**Key tools:** `navigate_page`, `click`, `fill`, `take_screenshot`, `take_snapshot`, `evaluate_script`, `wait_for`, `emulate`, `list_network_requests`.

**Kanban integration:** The preview button (Monitor icon) is available on tasks in Human Review and AI Review columns, allowing visual validation before PR approval.

## Integrated Tools

### grepai Integration

Semantic code search tool integrated for enhanced AI agent code exploration:

**Setup:**
```bash
# Start grepai server (Docker or CLI on http://localhost:9000)
cd src/connectors/grepai
python grepai_check.py  # Check integration
```

**Usage in Agents:**
```python
from src.connectors.grepai.client import GrepaiClient

client = GrepaiClient("http://localhost:9000")
results = client.search("user authentication flow", top_k=5)
```

**Features:**
- Natural language code search
- Vector embeddings for semantic matching
- Call graph tracing with `grepai trace`
- JSON output for AI agent integration
- Fallback to standard grep when unavailable

**Files:**
- `src/connectors/grepai/client.py` - Python client
- `src/connectors/grepai/grepai/` - Embedded grepai tool
- `src/connectors/grepai/README.md` - Integration guide

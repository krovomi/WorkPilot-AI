# WorkPilot AI UI - Frontend

A modern Electron + React desktop application for the WorkPilot AI autonomous coding framework.

## Prerequisites

### Node.js v24.12.0 LTS (Required)

This project requires **Node.js v24.12.0 LTS** (Latest LTS version as of December 2024).

**Download:** https://nodejs.org/en/download/

**Or install via command line:**

**Windows:**
```bash
winget install OpenJS.NodeJS.LTS
```

**macOS:**
```bash
brew install node@24
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

**Linux (Fedora):**
```bash
sudo dnf install nodejs npm
```

> **IMPORTANT:** When installing Node.js on Windows, make sure to check:
> - "Add to PATH"
> - "npm package manager"

**Verify installation:**
```bash
node --version  # Should output: v24.12.0
npm --version   # Should output: 11.x.x or higher
```

> **Note:** npm is included with Node.js. If `npm` is not found after installing Node.js, you need to reinstall Node.js properly.

## Quick Start

```bash
# Navigate to frontend directory
cd apps/frontend

# Install dependencies (includes native module rebuild)
pnpm install

# Start development server
pnpm run dev
```

## Security

This project maintains **0 vulnerabilities**. Run `pnpm audit` to verify.

```bash
pnpm audit
# Expected output: found 0 vulnerabilities
```

## Architecture

This project follows a **feature-based architecture** for better maintainability and scalability.

```
src/
├── main/                    # Electron main process
│   ├── agent/               # Agent queue management
│   ├── automations/         # Rules that turn an event into a draft Kanban card
│   ├── changelog/           # Changelog generation
│   ├── claude-profile/      # Multi-account provider profile management
│   ├── claude-code-settings/# Claude Code settings bridge
│   ├── insights/            # Code analysis
│   ├── integrations/        # Integration handlers
│   ├── ipc-handlers/        # IPC communication handlers (110+ modules; task/ holds PR follow-through, goal, best-of-N)
│   ├── mcp-apps/            # MCP Apps views, served on workpilot-mcp-app:// to the task panel
│   ├── needs-you/           # "Needs you" notifications: desktop, ntfy, Telegram plan approval
│   ├── platform/            # Cross-platform abstraction
│   ├── security/            # IPC sender, directory, tool-path and backend-path policies
│   ├── services/            # SDK session recovery, etc.
│   ├── terminal/            # PTY daemon and terminal lifecycle
│   └── updater/             # App update service
│
├── preload/                 # Electron preload scripts
│   └── api/                 # IPC API modules
│
├── renderer/                # React frontend
│   ├── components/          # Feature UIs (90+ folders: kanban, mission-control,
│   │                        #   formula-lab, agent-debugger, agent-replay,
│   │                        #   consensus-arbiter, carbon-profiler, arena, …)
│   ├── contexts/            # React context providers
│   ├── stores/              # Zustand stores (task-store, project-store, …)
│   ├── hooks/               # Shared React hooks
│   ├── services/            # Renderer-side services
│   ├── lib/                 # Utilities and helpers
│   ├── locales/             # i18n bundles (English + French)
│   ├── styles/              # Themes and global styles
│   └── assets/              # Icons and images
│
└── shared/                  # Shared between main/renderer
    ├── types/               # TypeScript type definitions
    ├── constants/           # Application constants
    └── utils/               # Shared utilities
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm run dev` | Start development server with hot reload |
| `pnpm run build` | Build for production |
| `pnpm run package` | Build and package for current platform |
| `pnpm run package:win` | Package for Windows |
| `pnpm run package:mac` | Package for macOS |
| `pnpm run package:linux` | Package for Linux |
| `pnpm test` | Run unit tests |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run test:coverage` | Run tests with coverage |
| `pnpm run lint` | Check for lint errors |
| `pnpm run lint:fix` | Auto-fix lint errors |
| `pnpm run typecheck` | Type check TypeScript |
| `pnpm audit` | Check for security vulnerabilities |

## Development Guidelines

### Code Organization Principles

1. **Feature-based Architecture**: Group related code by feature, not by type
2. **Single Responsibility**: Each component/hook/store does one thing well
3. **DRY (Don't Repeat Yourself)**: Extract reusable logic into shared modules
4. **KISS (Keep It Simple)**: Prefer simple solutions over complex ones
5. **SOLID Principles**: Apply object-oriented design principles

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Components | PascalCase | `TaskCard.tsx` |
| Hooks | camelCase with `use` prefix | `useTaskStore.ts` |
| Stores | kebab-case with `-store` suffix | `task-store.ts` |
| Types | PascalCase | `Task`, `TaskStatus` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_RETRIES` |

### TypeScript Guidelines

- **No implicit `any`**: Always type your variables and parameters
- **Use `type` for simple objects**: Prefer `type` over `interface`
- **Export types separately**: Use `export type` for type-only exports

### Security Guidelines

- **Never expose secrets**: API keys and tokens stay in the main process. A handler hands the renderer `MASKED_SECRET` for a stored credential and reads the mask coming back as "keep the stored value" (`src/main/utils/masked-secret.ts`). A masked key is only used with the URL it was saved for. Calls to a provider with a key are made in main.
- **Validate IPC data**: Always validate data coming through IPC. A path from the renderer is resolved with `src/main/security/renderer-path.ts` and must sit in a registered project or a folder the user picked in a native dialog; a new handler parameter named like a directory (`projectPath`, `worktreePath`, `specDir`…) goes in `DIRECTORY_ARGS` (`src/main/security/ipc-path-policy.ts`), which its test enforces. The renderer never names an executable to run. Only the app's own page reaches a handler (`src/main/security/ipc-sender-policy.ts`). A tool path or the backend folder typed in the settings is checked before it is saved (`src/main/security/tool-path-policy.ts`); a value already stored is kept.
- **Use contextBridge**: Never expose Node.js APIs directly to renderer
- **Name channels by constant**: a channel is written once, in `IPC_CHANNELS` (`src/shared/constants/ipc.ts`), and every handler, call, send and listener names it from there. `src/main/ipc-handlers/__tests__/ipc-channel-parity.test.ts` checks both directions (an event main sends has a preload listener, and the reverse), refuses a literal channel and an unused constant. Listeners of main events are registered in `src/renderer/stores/global-listeners.ts`.
- **Experimental views**: a view with neither a design file in `docs/architecture/` nor a test is listed in `src/renderer/components/sidebar/experimental-views.ts`. The sidebar badges it and can hide all of them (`SidebarPrefs.hideExperimental`). Give the view a design file or a test, then remove it from that list and from the last column of `docs/architecture/product-overview.md`.

## Troubleshooting

### npm not found

If `npm` command is not recognized after installing Node.js:

1. **Windows**: Reinstall Node.js from https://nodejs.org and ensure you check "Add to PATH"
2. **macOS/Linux**: Add to your shell profile:
   ```bash
   export PATH="/usr/local/bin:$PATH"
   ```
3. Restart your terminal

### Native module errors

If you get errors about native modules (`@lydell/node-pty`, `better-sqlite3`):

```bash
pnpm run rebuild
```

### Windows build tools required

If electron-rebuild fails on Windows, install Visual Studio Build Tools:

1. Download from https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. Select "Desktop development with C++" workload
3. Restart terminal and run `pnpm install` again

## Git Hooks

This project uses Husky for Git hooks that run automatically:

### Pre-commit Hook

Runs before each commit:
- **lint-staged**: Lints staged `.ts`/`.tsx` files
- **typecheck**: TypeScript type checking
- **lint**: ESLint checks
- **npm audit**: Security vulnerability check (high severity)

### Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/). Your commit messages must follow this format:

```
type(scope): description
```

**Valid types:**
| Type | Description |
|------|-------------|
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation changes |
| `style` | Code style (formatting, semicolons, etc.) |
| `refactor` | Code refactoring (no feature/fix) |
| `perf` | Performance improvements |
| `test` | Adding or updating tests |
| `build` | Build system or dependencies |
| `ci` | CI/CD configuration |
| `chore` | Maintenance tasks |
| `revert` | Reverting a previous commit |

**Examples:**
```bash
git commit -m "feat(tasks): add drag and drop support"
git commit -m "fix(terminal): resolve scroll position issue"
git commit -m "docs: update README with setup instructions"
git commit -m "chore: update dependencies"
```

## Package Manager

This project uses **pnpm** (`pnpm@12.5.1`, pinned by `packageManager` in the root `package.json`). Install dependencies with `pnpm install` and run scripts with `pnpm run <script>`. Lock files for other package managers are ignored.

## License

AGPL-3.0

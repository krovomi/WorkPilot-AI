/**
 * What `jsx-literal-text.test.ts` lets through. Every entry is a reason, not
 * a convenience: a sentence a user reads goes through `t()`, in `en` and `fr`.
 *
 * Four kinds of exemption, from the most general to the most specific:
 *
 * 1. Verbatim elements — text inside `<code>`, `<pre>`, `<kbd>`, `<samp>`,
 *    `<style>` or `<script>` is a command, a path, a key name or CSS, and
 *    reads the same in every language (`VERBATIM_ELEMENTS`).
 * 2. Names and terms — a text that is a product name (`NAMES`), or whose every
 *    word is a brand, a unit, an acronym or a key name (`TERMS`) or a single
 *    letter (`s`, `x`, `v` next to a number). `Claude`, `GitHub Copilot`,
 *    `MB`, `ms`, `JSON` stay as they are in French too. A word joins `TERMS`
 *    only if it is never translated. A bare domain or URL used as link text
 *    (`cli.github.com`) counts as a name.
 * 3. Example inputs — a `placeholder` made of one token that looks like a
 *    value rather than a sentence (`main`, `https://…`, `owner/repo`,
 *    `ghp_xxxx`): lowercase first letter, or a `/ : _ @ # $ ^ \ {` or digit.
 * 4. `FILE_EXEMPTIONS` — a literal in one file, with why it is not prose.
 *
 * `PENDING` is not an exemption: it is the debt left in files another branch
 * is rewriting, counted so it can only shrink. Remove an entry once its file
 * is translated; the test fails when a count is lower than written here.
 */

export const VERBATIM_ELEMENTS: ReadonlySet<string> = new Set([
	"code",
	"pre",
	"kbd",
	"samp",
	"style",
	"script",
]);

export const TERMS: ReadonlySet<string> = new Set([
	// Products, companies and services: never translated.
	"Anthropic",
	"AWS",
	"Azure",
	"Canny",
	"Claude",
	"Codex",
	"Copilot",
	"copilot",
	"DeepSeek",
	"DevOps",
	"Docker",
	"Gemini",
	"GitHub",
	"GitLab",
	"Google",
	"Jenkins",
	"Jira",
	"Kanban",
	"Linux",
	"macOS",
	"Markdown",
	"Microsoft",
	"Mistral",
	"Ollama",
	"OpenAI",
	"Playwright",
	"Slack",
	"Windows",
	"Windsurf",
	"WorkPilot",
	// Languages, formats, protocols and tools.
	"API",
	"CI",
	"CLI",
	"CSS",
	"CSV",
	"gh",
	"git",
	"HTML",
	"HTTP",
	"ID",
	"Java",
	"JavaScript",
	"JSON",
	"MCP",
	"MR",
	"npm",
	"OAuth",
	"pnpm",
	"PR",
	"Python",
	"TypeScript",
	"URL",
	// Units and accessibility levels.
	"AA",
	"AAA",
	"GB",
	"KB",
	"kg",
	"kWh",
	"MB",
	"ms",
	"tok",
	"vs",
	// Key names.
	"Alt",
	"Cmd",
	"Ctrl",
	"ESC",
	"esc",
	"Shift",
]);

/**
 * Whole texts that are names although some of their words are ordinary
 * English (`Code`, `AI`, `Teams`, `Cursor`): exempt only as the full name, so
 * a lone `Code` or `AI` label is still caught (`AI` is `IA` in French).
 */
export const NAMES: ReadonlySet<string> = new Set([
	"Azure DevOps Pipelines",
	"Claude Code",
	"Claude Code CLI",
	"Cursor",
	"GitHub Actions",
	"Linear",
	"llama.cpp",
	"LM Studio",
	"Meta",
	"Microsoft Teams",
	"Mistral AI",
	"Node",
	"WorkPilot AI",
]);

export interface FileExemption {
	/** The literal, whitespace collapsed, exactly as the test reports it. */
	readonly text: string;
	/** Why it is not prose a user should read in their language. */
	readonly reason: string;
}

const SHELL = "shell command shown verbatim, in a monospace block";
const HTTP_HEADER = "HTTP header shown as sent";
const OPENAPI = "OpenAPI keyword shown verbatim next to the schema";

/** Paths are relative to `src/renderer/`. */
export const FILE_EXEMPTIONS: Readonly<
	Record<string, readonly FileExemption[]>
> = {
	"components/CodexCliStatusBadge.tsx": [
		{ text: "install -g @openai/codex@latest", reason: SHELL },
	],
	"components/CustomMcpDialog.tsx": [
		{
			text: "@placeholder=-y @myorg/my-mcp-server",
			reason: "example command-line arguments",
		},
	],
	"components/GitSetupModal.tsx": [
		{ text: "git init", reason: SHELL },
		{ text: "git add .", reason: SHELL },
		{
			text: 'git commit -m "',
			reason: `${SHELL}; the message itself is translated`,
		},
	],
	"components/project-settings/GeneralSettings.tsx": [
		{ text: "git init", reason: SHELL },
		{ text: "git add -A", reason: SHELL },
		{ text: 'git commit -m "Initial commit"', reason: SHELL },
	],
	"components/api-explorer/ApiExplorer.tsx": [
		{ text: "deprecated", reason: OPENAPI },
	],
	"components/api-explorer/EnvironmentManager.tsx": [
		{ text: "@placeholder=X-API-Key: key X-Custom: value", reason: HTTP_HEADER },
		{ text: "Bearer ••••", reason: HTTP_HEADER },
		{ text: "@placeholder=X-API-Key: key", reason: HTTP_HEADER },
	],
	"components/api-explorer/RequestPanel.tsx": [
		{ text: "required", reason: OPENAPI },
		{ text: "?↗ ref", reason: OPENAPI },
		{ text: "items:", reason: OPENAPI },
		{ text: "?any", reason: OPENAPI },
		{ text: "Authorization: Bearer ••••", reason: HTTP_HEADER },
		{ text: "@placeholder=X-API-Key", reason: HTTP_HEADER },
		{
			text: "@placeholder=openid profile email",
			reason: "OAuth scope names, typed as is",
		},
	],
	"components/mcp-marketplace/McpBuilder.tsx": [
		{
			text: '@placeholder={"name": "{{name}}", "email": "{{email}}"}',
			reason: "JSON template example",
		},
	],
	"components/settings/GuardrailsSettings.tsx": [
		{ text: "@placeholder=Write, Edit, Bash", reason: "agent tool names" },
		{
			text: "@placeholder=git push --force origin main",
			reason: "example shell command",
		},
	],
	"components/task-detail/TaskVerify.tsx": [
		{ text: "?2xx", reason: "HTTP status class" },
		{ text: "@label=LCP", reason: "Web Vitals metric name" },
		{ text: "@label=CLS", reason: "Web Vitals metric name" },
		{ text: "@label=TBT", reason: "Web Vitals metric name" },
		{ text: "@label=FCP", reason: "Web Vitals metric name" },
	],
};

/**
 * Literals left in files another branch rewrites: the task panel (PR #648)
 * and the sidebar being restructured. Translate them there, then delete the
 * entry. Counts may only go down.
 */
export const PENDING: Readonly<Record<string, number>> = {
	"components/task-detail/TaskDetailModal.tsx": 1,
	"components/task-detail/GoalCard.tsx": 1,
};

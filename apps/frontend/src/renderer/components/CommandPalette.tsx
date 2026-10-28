import {
	BarChart3,
	BookOpen,
	BookOpenCheck,
	CalendarClock,
	Coins,
	Download,
	FileCode2,
	FileText,
	GitBranch,
	GitMerge,
	GitPullRequest,
	Globe,
	History,
	Keyboard,
	LayoutGrid,
	Lightbulb,
	type LucideIcon,
	// biome-ignore lint/suspicious/noShadowRestrictedNames: shadow name is intentional
	Map,
	PlusCircle,
	Router,
	Search,
	Settings,
	Shield,
	ShieldAlert,
	Sparkles,
	Sun,
	Terminal,
	Wand2,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandCategory =
	| "tasks"
	| "navigation"
	| "agents"
	| "settings"
	| "providers"
	| "terminal"
	| "help";

export interface PaletteCommand {
	id: string;
	label: string;
	description: string;
	category: CommandCategory;
	icon: LucideIcon;
	shortcut?: string;
	keywords?: string[];
	handler?: () => void;
}

interface CommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onNavigate: (view: string) => void;
	onNewTask: () => void;
	onOpenSettings: () => void;
	onOpenSettingsSection?: (section: string) => void;
	onToggleTheme?: () => void;
}

// ---------------------------------------------------------------------------
// Fuzzy matching
// ---------------------------------------------------------------------------

function fuzzyMatch(
	query: string,
	text: string,
): { match: boolean; score: number } {
	if (!query) return { match: true, score: 0 };

	const q = query.toLowerCase();
	const t = text.toLowerCase();

	// Exact substring match — highest score
	if (t.includes(q)) {
		const bonus = t.startsWith(q) ? 20 : 0;
		return { match: true, score: 100 + bonus - t.length };
	}

	// Character-by-character fuzzy match
	let qi = 0;
	let score = 0;
	let lastMatchIndex = -1;

	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			// Consecutive match bonus
			if (lastMatchIndex === ti - 1) {
				score += 8;
			}
			// Word boundary bonus
			else if (
				ti === 0 ||
				t[ti - 1] === " " ||
				t[ti - 1] === "-" ||
				t[ti - 1] === "_"
			) {
				score += 6;
			} else {
				score += 4;
			}
			lastMatchIndex = ti;
			qi++;
		}
	}

	if (qi === q.length) {
		// Penalize long texts
		score -= Math.max(0, t.length - q.length);
		return { match: true, score };
	}

	return { match: false, score: 0 };
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

function getBuiltinCommands(
	t: TFunction,
	onNavigate: (view: string) => void,
	onNewTask: () => void,
	onOpenSettings: () => void,
	onToggleTheme?: () => void,
	onOpenSettingsSection?: (section: string) => void,
): PaletteCommand[] {
	return [
		{
			id: "create_task",
			label: t("commandPalette.commands.create_task.label"),
			description: t("commandPalette.commands.create_task.description"),
			category: "tasks",
			icon: PlusCircle,
			shortcut: "Ctrl+N",
			keywords: ["new", "add", "task", "create"],
			handler: onNewTask,
		},
		{
			id: "search_tasks",
			label: t("commandPalette.commands.search_tasks.label"),
			description: t("commandPalette.commands.search_tasks.description"),
			category: "tasks",
			icon: Search,
			shortcut: "/",
			keywords: ["find", "filter", "search"],
			handler: () => onNavigate("kanban"),
		},
		{
			id: "go_kanban",
			label: t("commandPalette.commands.go_kanban.label"),
			description: t("commandPalette.commands.go_kanban.description"),
			category: "navigation",
			icon: LayoutGrid,
			shortcut: "Ctrl+1",
			keywords: ["board", "tasks", "kanban"],
			handler: () => onNavigate("kanban"),
		},
		{
			id: "go_terminals",
			label: t("commandPalette.commands.go_terminals.label"),
			description: t("commandPalette.commands.go_terminals.description"),
			category: "navigation",
			icon: Terminal,
			shortcut: "Ctrl+2",
			keywords: ["terminal", "shell", "console"],
			handler: () => onNavigate("terminals"),
		},
		{
			id: "go_insights",
			label: t("commandPalette.commands.go_insights.label"),
			description: t("commandPalette.commands.go_insights.description"),
			category: "navigation",
			icon: Sparkles,
			shortcut: "Ctrl+3",
			keywords: ["insights", "ai", "chat", "analytics"],
			handler: () => onNavigate("insights"),
		},
		{
			id: "go_roadmap",
			label: t("commandPalette.commands.go_roadmap.label"),
			description: t("commandPalette.commands.go_roadmap.description"),
			category: "navigation",
			icon: Map,
			shortcut: "Ctrl+4",
			keywords: ["roadmap", "plan", "timeline"],
			handler: () => onNavigate("roadmap"),
		},
		{
			id: "go_ideation",
			label: t("commandPalette.commands.go_ideation.label"),
			description: t("commandPalette.commands.go_ideation.description"),
			category: "navigation",
			icon: Lightbulb,
			keywords: ["ideation", "brainstorm", "ideas"],
			handler: () => onNavigate("ideation"),
		},
		{
			id: "go_context",
			label: t("commandPalette.commands.go_context.label"),
			description: t("commandPalette.commands.go_context.description"),
			category: "navigation",
			icon: BookOpen,
			keywords: ["context", "memory", "knowledge"],
			handler: () => onNavigate("context"),
		},
		{
			id: "go_agent_tools",
			label: t("commandPalette.commands.go_agent_tools.label"),
			description: t("commandPalette.commands.go_agent_tools.description"),
			category: "navigation",
			icon: Wrench,
			keywords: ["tools", "agent", "mcp"],
			handler: () => onNavigate("agent-tools"),
		},
		{
			id: "go_changelog",
			label: t("commandPalette.commands.go_changelog.label"),
			description: t("commandPalette.commands.go_changelog.description"),
			category: "navigation",
			icon: FileText,
			keywords: ["changelog", "updates", "history"],
			handler: () => onNavigate("changelog"),
		},
		{
			id: "go_worktrees",
			label: t("commandPalette.commands.go_worktrees.label"),
			description: t("commandPalette.commands.go_worktrees.description"),
			category: "navigation",
			icon: GitBranch,
			keywords: ["worktrees", "git", "branches"],
			handler: () => onNavigate("worktrees"),
		},
		{
			id: "go_dashboard",
			label: t("commandPalette.commands.go_dashboard.label"),
			description: t("commandPalette.commands.go_dashboard.description"),
			category: "navigation",
			icon: BarChart3,
			keywords: ["dashboard", "metrics", "kpi", "analytics", "stats"],
			handler: () => onNavigate("dashboard"),
		},
		{
			id: "go_code_review",
			label: t("commandPalette.commands.go_code_review.label"),
			description: t("commandPalette.commands.go_code_review.description"),
			category: "navigation",
			icon: FileCode2,
			keywords: ["review", "code", "diff", "quality"],
			handler: () => onNavigate("code-review"),
		},
		{
			id: "go_refactoring",
			label: t("commandPalette.commands.go_refactoring.label"),
			description: t("commandPalette.commands.go_refactoring.description"),
			category: "navigation",
			icon: Wand2,
			keywords: ["refactor", "smells", "clean", "code"],
			handler: () => onNavigate("refactoring"),
		},
		{
			id: "go_documentation",
			label: t("commandPalette.commands.go_documentation.label"),
			description: t("commandPalette.commands.go_documentation.description"),
			category: "navigation",
			icon: BookOpenCheck,
			keywords: ["docs", "documentation", "docstring", "readme"],
			handler: () => onNavigate("documentation"),
		},
		{
			id: "go_cost_estimator",
			label: t("commandPalette.commands.go_cost_estimator.label"),
			description: t("commandPalette.commands.go_cost_estimator.description"),
			category: "navigation",
			icon: Coins,
			keywords: ["cost", "budget", "spending", "tokens", "money"],
			handler: () => onNavigate("cost-estimator"),
		},
		{
			id: "go_session_history",
			label: t("commandPalette.commands.go_session_history.label"),
			description: t("commandPalette.commands.go_session_history.description"),
			category: "navigation",
			icon: History,
			keywords: ["sessions", "history", "timeline", "past"],
			handler: () => onNavigate("session-history"),
		},
		{
			id: "go_migration",
			label: t("commandPalette.commands.go_migration.label"),
			description: t("commandPalette.commands.go_migration.description"),
			category: "navigation",
			icon: Download,
			keywords: ["migration", "framework", "upgrade", "wizard"],
			handler: () => onNavigate("migration"),
		},
		{
			id: "go_visual_programming",
			label: t("commandPalette.commands.go_visual_programming.label"),
			description: t("commandPalette.commands.go_visual_programming.description"),
			category: "navigation",
			icon: Sparkles,
			keywords: ["visual", "programming", "nodes", "flow"],
			handler: () => onNavigate("visual-programming"),
		},
		{
			id: "go_github_issues",
			label: t("commandPalette.commands.go_github_issues.label"),
			description: t("commandPalette.commands.go_github_issues.description"),
			category: "navigation",
			icon: Globe,
			keywords: ["github", "issues", "bugs", "tickets"],
			handler: () => onNavigate("github-issues"),
		},
		{
			id: "go_github_prs",
			label: t("commandPalette.commands.go_github_prs.label"),
			description: t("commandPalette.commands.go_github_prs.description"),
			category: "navigation",
			icon: GitPullRequest,
			keywords: ["github", "pull", "requests", "prs", "review"],
			handler: () => onNavigate("github-prs"),
		},
		{
			id: "go_gitlab_issues",
			label: t("commandPalette.commands.go_gitlab_issues.label"),
			description: t("commandPalette.commands.go_gitlab_issues.description"),
			category: "navigation",
			icon: GitMerge,
			keywords: ["gitlab", "issues", "bugs", "tickets"],
			handler: () => onNavigate("gitlab-issues"),
		},
		{
			id: "go_gitlab_merge_requests",
			label: t("commandPalette.commands.go_gitlab_merge_requests.label"),
			description: t("commandPalette.commands.go_gitlab_merge_requests.description"),
			category: "navigation",
			icon: GitMerge,
			keywords: ["gitlab", "merge", "requests", "mrs", "review"],
			handler: () => onNavigate("gitlab-merge-requests"),
		},
		{
			id: "go_settings",
			label: t("commandPalette.commands.go_settings.label"),
			description: t("commandPalette.commands.go_settings.description"),
			category: "settings",
			icon: Settings,
			shortcut: "Ctrl+,",
			keywords: ["settings", "preferences", "config"],
			handler: onOpenSettings,
		},
		...(onOpenSettingsSection
			? [
					{
						id: "open_sandbox_settings",
						label: t("commandPalette.commands.open_sandbox_settings.label"),
						description: t("commandPalette.commands.open_sandbox_settings.description"),
						category: "settings" as CommandCategory,
						icon: Shield,
						keywords: [
							"sandbox",
							"security",
							"isolation",
							"whitelist",
							"rollback",
						],
						handler: () => onOpenSettingsSection("sandbox"),
					},
					{
						id: "open_anomaly_settings",
						label: t("commandPalette.commands.open_anomaly_settings.label"),
						description: t("commandPalette.commands.open_anomaly_settings.description"),
						category: "settings" as CommandCategory,
						icon: ShieldAlert,
						keywords: [
							"anomaly",
							"detection",
							"trust",
							"score",
							"monitoring",
							"security",
						],
						handler: () => onOpenSettingsSection("anomaly-detection"),
					},
					{
						id: "open_router_settings",
						label: t("commandPalette.commands.open_router_settings.label"),
						description: t("commandPalette.commands.open_router_settings.description"),
						category: "settings" as CommandCategory,
						icon: Router,
						keywords: [
							"router",
							"llm",
							"provider",
							"fallback",
							"ab",
							"testing",
							"routing",
						],
						handler: () => onOpenSettingsSection("llm-router"),
					},
					{
						id: "open_scheduler_settings",
						label: t("commandPalette.commands.open_scheduler_settings.label"),
						description: t("commandPalette.commands.open_scheduler_settings.description"),
						category: "settings" as CommandCategory,
						icon: CalendarClock,
						keywords: [
							"scheduler",
							"cron",
							"schedule",
							"recurring",
							"chain",
							"queue",
						],
						handler: () => onOpenSettingsSection("scheduler"),
					},
				]
			: []),
		{
			id: "toggle_theme",
			label: t("commandPalette.commands.toggle_theme.label"),
			description: t("commandPalette.commands.toggle_theme.description"),
			category: "settings",
			icon: Sun,
			keywords: ["theme", "dark", "light", "mode"],
			handler: onToggleTheme,
		},
		{
			id: "new_terminal",
			label: t("commandPalette.commands.new_terminal.label"),
			description: t("commandPalette.commands.new_terminal.description"),
			category: "terminal",
			icon: Terminal,
			shortcut: "Ctrl+Shift+T",
			keywords: ["terminal", "new", "shell"],
			handler: () => onNavigate("terminals"),
		},
		{
			id: "keyboard_shortcuts",
			label: t("commandPalette.commands.keyboard_shortcuts.label"),
			description: t("commandPalette.commands.keyboard_shortcuts.description"),
			category: "help",
			icon: Keyboard,
			shortcut: "Ctrl+/",
			keywords: ["shortcuts", "keyboard", "keys", "help"],
		},
		{
			id: "export_report",
			label: t("commandPalette.commands.export_report.label"),
			description: t("commandPalette.commands.export_report.description"),
			category: "tasks",
			icon: Download,
			keywords: ["export", "report", "download", "csv", "json"],
		},
	];
}

// ---------------------------------------------------------------------------
// Category labels & colors
// ---------------------------------------------------------------------------

const CATEGORIES: CommandCategory[] = [
	"tasks",
	"navigation",
	"agents",
	"settings",
	"providers",
	"terminal",
	"help",
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
	open,
	onOpenChange,
	onNavigate,
	onNewTask,
	onOpenSettings,
	onOpenSettingsSection,
	onToggleTheme,
}: CommandPaletteProps) {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const commands = useMemo(
		() =>
			getBuiltinCommands(
				t,
				onNavigate,
				onNewTask,
				onOpenSettings,
				onToggleTheme,
				onOpenSettingsSection,
			),
		[
			t,
			onNavigate,
			onNewTask,
			onOpenSettings,
			onToggleTheme,
			onOpenSettingsSection,
		],
	);

	// Filtered & scored results
	const results = useMemo(() => {
		if (!query.trim()) {
			// Show navigation commands first when no query
			return commands.sort((a, b) => {
				const order: CommandCategory[] = [
					"navigation",
					"tasks",
					"agents",
					"terminal",
					"settings",
					"providers",
					"help",
				];
				return order.indexOf(a.category) - order.indexOf(b.category);
			});
		}

		const searchText = query.trim();
		const scored = commands
			.map((cmd) => {
				const labelMatch = fuzzyMatch(searchText, cmd.label);
				const descMatch = fuzzyMatch(searchText, cmd.description);
				const keywordScore = (cmd.keywords || []).reduce((best, kw) => {
					const m = fuzzyMatch(searchText, kw);
					return m.match && m.score > best ? m.score : best;
				}, 0);
				const bestScore = Math.max(
					labelMatch.match ? labelMatch.score : -Infinity,
					descMatch.match ? descMatch.score * 0.7 : -Infinity,
					keywordScore * 0.8,
				);
				return {
					cmd,
					score: bestScore,
					match: labelMatch.match || descMatch.match || keywordScore > 0,
				};
			})
			.filter((r) => r.match)
			.sort((a, b) => b.score - a.score);

		return scored.map((r) => r.cmd);
	}, [query, commands]);

	// Reset on open
	useEffect(() => {
		if (open) {
			setQuery("");
			setSelectedIndex(0);
			// Focus input after a small delay for the DOM to render
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	// Reset selection when results change
	useEffect(() => {
		setSelectedIndex(0);
	}, []);

	// Scroll selected item into view
	useEffect(() => {
		if (!listRef.current) return;
		const items = listRef.current.querySelectorAll("[data-command-item]");
		items[selectedIndex]?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const executeCommand = useCallback(
		(cmd: PaletteCommand) => {
			onOpenChange(false);
			if (cmd.handler) {
				// Delay slightly so the palette closes first
				requestAnimationFrame(() => cmd.handler?.());
			}
		},
		[onOpenChange],
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
					break;
				case "ArrowUp":
					e.preventDefault();
					setSelectedIndex((i) => Math.max(i - 1, 0));
					break;
				case "Enter":
					e.preventDefault();
					if (results[selectedIndex]) {
						executeCommand(results[selectedIndex]);
					}
					break;
				case "Escape":
					e.preventDefault();
					onOpenChange(false);
					break;
			}
		},
		[results, selectedIndex, executeCommand, onOpenChange],
	);

	if (!open) return null;

	// Group results by category
	const grouped = results.reduce<Record<string, PaletteCommand[]>>(
		(acc, cmd) => {
			if (!acc[cmd.category]) acc[cmd.category] = [];
			acc[cmd.category].push(cmd);
			return acc;
		},
		{},
	);

	// Flatten for index tracking
	let flatIndex = 0;

	return (
		<div
			role="none"
			className="fixed inset-0 z-100"
			onClick={() => onOpenChange(false)}
			onKeyDown={(e) => e.key === "Escape" && onOpenChange(false)}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

			{/* Palette */}
			{/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: stop-propagation handler, not a primary interaction */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: stop-propagation handler, not a primary interaction */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard events handled by outer container */}
			<div
				className="absolute left-1/2 top-[20%] w-full max-w-lg -translate-x-1/2 animate-in fade-in slide-in-from-top-4 duration-200"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
					{/* Search input */}
					<div className="flex items-center gap-3 border-b border-border px-4 py-3">
						<Search className="h-4 w-4 shrink-0 text-muted-foreground" />
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={t("commandPalette.placeholder")}
							className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
							spellCheck={false}
						/>
						<kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-secondary px-1.5 font-mono text-[10px] text-muted-foreground">
							ESC
						</kbd>
					</div>

					{/* Results list */}
					<div ref={listRef} className="max-h-80 overflow-y-auto p-2">
						{results.length === 0 ? (
							<div className="px-4 py-8 text-center text-sm text-muted-foreground">
								{t("commandPalette.noResults", { query })}
							</div>
						) : (
							Object.entries(grouped).map(([category, cmds]) => (
								<div key={category}>
									<div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
										{CATEGORIES.includes(category as CommandCategory)
											? t(`commandPalette.categories.${category}`)
											: category}
									</div>
									{cmds.map((cmd) => {
										const itemIndex = flatIndex++;
										const isSelected = itemIndex === selectedIndex;
										const Icon = cmd.icon;

										return (
											<button
												type="button"
												key={cmd.id}
												data-command-item
												onClick={() => executeCommand(cmd)}
												onMouseEnter={() => setSelectedIndex(itemIndex)}
												className={cn(
													"flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
													isSelected
														? "bg-accent text-accent-foreground"
														: "text-foreground hover:bg-accent/50",
												)}
											>
												<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
												<div className="flex flex-1 flex-col items-start gap-0.5">
													<span className="font-medium">{cmd.label}</span>
													<span className="text-xs text-muted-foreground">
														{cmd.description}
													</span>
												</div>
												{cmd.shortcut && (
													<kbd className="ml-auto hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-secondary px-1.5 font-mono text-[10px] text-muted-foreground">
														{cmd.shortcut}
													</kbd>
												)}
											</button>
										);
									})}
								</div>
							))
						)}
					</div>

					{/* Footer */}
					<div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-[10px]">
									↑↓
								</kbd>
								{t("commandPalette.footer.navigate")}
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-[10px]">
									↵
								</kbd>
								{t("commandPalette.footer.select")}
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-[10px]">
									esc
								</kbd>
								{t("commandPalette.footer.close")}
							</span>
						</div>
						<span>
							{t("commandPalette.count", { count: results.length })}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}

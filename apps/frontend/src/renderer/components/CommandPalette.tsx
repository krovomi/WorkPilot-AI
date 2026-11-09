import {
	CalendarClock,
	Download,
	Keyboard,
	type LucideIcon,
	Mic,
	PlusCircle,
	Router,
	Search,
	Settings,
	Shield,
	ShieldAlert,
	Sun,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { useViewUsageStore } from "../stores/view-usage-store";
import { openVoiceAssistant } from "../stores/voice-assistant-store";
import type { SidebarView } from "./Sidebar";
import { openNavView } from "./sidebar/nav-actions";
import { type NavIndexEntry, useNavIndexStore } from "./sidebar/nav-index";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandCategory =
	| "recent"
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

/** Lower case without accents: « securite » finds « Sécurité ». */
function foldText(text: string): string {
	return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function fuzzyMatch(
	query: string,
	text: string,
): { match: boolean; score: number } {
	if (!query) return { match: true, score: 0 };

	const q = foldText(query);
	const t = foldText(text);

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
			id: "voice_assistant",
			label: t("commandPalette.commands.voice_assistant.label"),
			description: t("commandPalette.commands.voice_assistant.description"),
			category: "tasks",
			icon: Mic,
			shortcut: "Ctrl+Shift+Space",
			keywords: ["voice", "speech", "dictate", "vocal", "voix", "micro"],
			handler: openVoiceAssistant,
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
// Pages of the menu
// ---------------------------------------------------------------------------

/** The menu's last segment of an item key: `navigation:items.flakyTests` → `flakyTests`. */
function itemKeyOf(labelKey: string): string {
	return labelKey.slice(labelKey.lastIndexOf(".") + 1);
}

/**
 * One command per page the sidebar shows (`sidebar/nav-index.ts`): found by
 * its name, where it sits in the menu and a few words people search with, and
 * opened the way the sidebar opens it (a tool that is a dialog opens it).
 */
function pageCommands(
	t: TFunction,
	entries: readonly NavIndexEntry[],
	onNavigate: (view: string) => void,
): PaletteCommand[] {
	return entries.map((entry) => {
		const place = entry.placeKeys.map((key) => t(key));
		if (entry.experimental) place.push(t("commandPalette.beta"));
		const keywords = t(`navigation:keywords.${itemKeyOf(entry.labelKey)}`, {
			defaultValue: "",
		});
		return {
			id: `page:${entry.view}`,
			label: t(entry.labelKey),
			description: place.join(" · "),
			category: "navigation",
			icon: entry.icon,
			shortcut: entry.shortcut,
			keywords: [...place, ...keywords.split(" ").filter(Boolean)],
			handler: () => openNavView(entry.view, (view: SidebarView) => onNavigate(view)),
		};
	});
}

/** The pages opened last, most recent first, as « Recent » commands. */
function recentCommands(
	pages: readonly PaletteCommand[],
	usage: Partial<Record<SidebarView, { lastVisitedAt: number }>>,
	limit = 5,
): PaletteCommand[] {
	const byView = new Map(pages.map((cmd) => [cmd.id.slice("page:".length), cmd]));
	return (Object.entries(usage) as Array<[SidebarView, { lastVisitedAt: number }]>)
		.filter(([view]) => byView.has(view))
		.sort((a, b) => b[1].lastVisitedAt - a[1].lastVisitedAt)
		.slice(0, limit)
		.map(([view]) => {
			const cmd = byView.get(view) as PaletteCommand;
			return { ...cmd, id: `recent:${view}`, category: "recent" };
		});
}

// ---------------------------------------------------------------------------
// Category labels & colors
// ---------------------------------------------------------------------------

const CATEGORIES: CommandCategory[] = [
	"recent",
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

	const navEntries = useNavIndexStore((state) => state.entries);
	const usage = useViewUsageStore((state) => state.usage);
	const pages = useMemo(
		() => pageCommands(t, navEntries, onNavigate),
		[t, navEntries, onNavigate],
	);
	const builtins = useMemo(
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
	const commands = useMemo(() => [...pages, ...builtins], [pages, builtins]);

	// Filtered & scored results
	const results = useMemo(() => {
		if (!query.trim()) {
			// The pages opened last first, then the actions, then every page
			return [...recentCommands(pages, usage), ...builtins, ...pages].sort((a, b) => {
				const order: CommandCategory[] = [
					"recent",
					"tasks",
					"agents",
					"terminal",
					"settings",
					"providers",
					"help",
					"navigation",
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

		// With ~100 commands, a letter-by-letter match finds almost anything:
		// once some command contains the words typed, only those are listed.
		const folded = foldText(searchText);
		const contains = (cmd: PaletteCommand) =>
			[cmd.label, cmd.description, ...(cmd.keywords ?? [])].some((text) =>
				foldText(text).includes(folded),
			);
		const exact = scored.filter((r) => contains(r.cmd));
		return (exact.length > 0 ? exact : scored).map((r) => r.cmd);
	}, [query, commands, pages, builtins, usage]);

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
						<kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-secondary px-1.5 font-mono text-3xs text-muted-foreground">
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
													<kbd className="ml-auto hidden sm:inline-flex h-5 items-center gap-1 rounded border border-border bg-secondary px-1.5 font-mono text-3xs text-muted-foreground">
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
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
									↑↓
								</kbd>
								{t("commandPalette.footer.navigate")}
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
									↵
								</kbd>
								{t("commandPalette.footer.select")}
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-border bg-secondary px-1 font-mono text-3xs">
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

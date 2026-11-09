import { ListPlus, Loader2, Play, Terminal } from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { createTask, loadTasks } from "../../stores/task-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Quick slash-command bar for the Kanban toolbar.
 *
 * Fetches the merged list of slash commands (project / user / built-in) from
 * the FastAPI backend and lets the user fire one against the active project.
 * A command runs in the main process (`runQuickCommand`, F181): on the
 * provider chosen in the app, with the Claude profile's sign-in when that
 * provider needs it, in the worktree of a Kanban review card. What the agent
 * writes is committed on the card's branch and waits for review; it never
 * lands in the project folder. `/help` is answered here, from the list.
 *
 * The component is purely additive: when no project is active, the input is
 * disabled with a localised tooltip. All user-facing strings come from the
 * `tasks:kanban.quickCommand.*` i18n namespace (FR + EN provided).
 */

interface SlashCommand {
	name: string;
	description: string;
	source: "project" | "user" | "built-in";
	path: string;
}

interface QuickCommandBarProps {
	readonly projectPath?: string;
	readonly className?: string;
	readonly variant?: "default" | "compact";
}

const BACKEND_URL: string =
	(import.meta as { env?: { VITE_BACKEND_URL?: string } }).env
		?.VITE_BACKEND_URL || "";

/** Longest command output shown in the result toast. */
const MAX_OUTPUT_CHARS = 2000;

/** The command's result as text for the toast, cut to MAX_OUTPUT_CHARS. */
export function formatOutput(result: unknown): string {
	if (result === null || result === undefined) return "";
	const text = (
		typeof result === "string" ? result : JSON.stringify(result, null, 2)
	).trim();
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}…`
		: text;
}

export function QuickCommandBar({
	projectPath,
	className,
	variant = "default",
}: QuickCommandBarProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const [input, setInput] = useState("");
	const [commands, setCommands] = useState<SlashCommand[]>([]);
	const [isRunning, setIsRunning] = useState(false);
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	// Active Kanban tab — needed to attach a "Run as task" creation to a project.
	const activeProjectId = useProjectStore((s) => s.activeProjectId);

	const showError = useCallback(
		(detail?: string) => {
			toast({
				variant: "destructive",
				title: t("tasks:kanban.quickCommand.errorTitle"),
				description: detail,
			});
		},
		[t],
	);

	// Fetch command list whenever the active project changes. Errors are
	// swallowed: an empty picker is acceptable, we don't want to spam toasts
	// for a power-user affordance.
	useEffect(() => {
		if (!projectPath) {
			setCommands([]);
			return;
		}
		const controller = new AbortController();
		const url = `${BACKEND_URL}/api/slash-commands?project_dir=${encodeURIComponent(projectPath)}`;
		fetch(url, { signal: controller.signal })
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (data?.success && Array.isArray(data.commands)) {
					setCommands(data.commands as SlashCommand[]);
				}
			})
			.catch(() => {
				/* silent: feature is non-critical */
			});
		return () => controller.abort();
	}, [projectPath]);

	// Filter suggestions by what the user has typed (minus the leading slash).
	const filtered = useMemo(() => {
		const q = input.trim().replace(/^\//, "").toLowerCase();
		if (!q) return commands.slice(0, 12);
		return commands
			.filter(
				(c) =>
					c.name.toLowerCase().includes(q) ||
					c.description.toLowerCase().includes(q),
			)
			.slice(0, 12);
	}, [commands, input]);

	const parseInput = useCallback(
		(): { command: string; args: string } | null => {
			const raw = input.trim();
			if (!raw) return null;
			const noSlash = raw.startsWith("/") ? raw.slice(1) : raw;
			const [command, ...rest] = noSlash.split(/\s+/);
			if (!command) return null;
			return { command, args: rest.join(" ") };
		},
		[input],
	);

	// `/help` needs no agent: the bar already has the list.
	const showHelp = useCallback(() => {
		const lines = commands.map((c) =>
			c.description ? `/${c.name} — ${c.description}` : `/${c.name}`,
		);
		toast({
			title: t("tasks:kanban.quickCommand.helpTitle"),
			description: (
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">
					{formatOutput(lines.join("\n"))}
				</pre>
			),
		});
	}, [commands, t]);

	const runCommand = useCallback(
		async (override?: string) => {
			if (!projectPath || !activeProjectId) {
				toast({
					variant: "destructive",
					title: t("tasks:kanban.quickCommand.missingProject"),
				});
				return;
			}
			const parsed = override
				? { command: override, args: "" }
				: parseInput();
			if (!parsed) return;
			setOpen(false);
			if (parsed.command === "help") {
				showHelp();
				setInput("");
				return;
			}
			setIsRunning(true);
			try {
				const res = await globalThis.electronAPI.runQuickCommand({
					projectId: activeProjectId,
					command: parsed.command,
					args: parsed.args,
				});
				const outcome = res.data;
				if (!res.success || !outcome) {
					showError(res.error ?? "unknown");
					return;
				}
				const { review } = outcome;
				if (review) void loadTasks(activeProjectId, { forceRefresh: true });
				let note = "";
				if (review) {
					note = t("tasks:kanban.quickCommand.reviewCard", {
						count: review.files.length,
						branch: review.branch,
						card: review.title,
					});
				} else if (outcome.uncommittedIn) {
					note = t("tasks:kanban.quickCommand.uncommitted", {
						path: outcome.uncommittedIn,
					});
				}
				const output = formatOutput(outcome.output);
				toast({
					variant: outcome.ok ? "success" : "destructive",
					title: outcome.ok
						? `/${parsed.command} · ${t("tasks:kanban.quickCommand.successTitle")}`
						: `/${parsed.command} · ${t("tasks:kanban.quickCommand.errorTitle")}`,
					description:
						note || output ? (
							<div className="space-y-2">
								{note && <p className="text-xs">{note}</p>}
								{output && (
									<pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs">
										{output}
									</pre>
								)}
							</div>
						) : undefined,
				});
			} catch (err) {
				showError((err as Error).message);
			} finally {
				setIsRunning(false);
				setInput("");
			}
		},
		[projectPath, activeProjectId, parseInput, showError, showHelp, t],
	);

	// "Run as task": instead of a single run, seed a real Kanban task with
	// the command's instruction body so it flows through the interactive pipeline
	// (planning, plan-approval, conversation). The body is resolved server-side
	// from the agnostic .agents/skills/ source.
	const runAsTask = useCallback(
		async (override?: string) => {
			if (!projectPath || !activeProjectId) {
				toast({
					variant: "destructive",
					title: t("tasks:kanban.quickCommand.missingProject"),
				});
				return;
			}
			const parsed = override
				? { command: override, args: "" }
				: parseInput();
			if (!parsed) return;
			setIsRunning(true);
			setOpen(false);
			try {
				const url = `${BACKEND_URL}/api/slash-commands/body?project_dir=${encodeURIComponent(
					projectPath,
				)}&command=${encodeURIComponent(parsed.command)}`;
				const res = await fetch(url);
				const data = await res.json();
				if (!res.ok || !data?.success || !data.body) {
					showError(data?.detail ?? data?.error ?? "unknown");
					return;
				}
				const description = parsed.args.trim()
					? `${data.body}\n\nArguments: ${parsed.args.trim()}`
					: data.body;
				const created = await createTask(
					activeProjectId,
					`/${parsed.command}`,
					description,
				);
				if (created) {
					toast({
						variant: "success",
						title: t("tasks:kanban.quickCommand.taskCreated", {
							name: `/${parsed.command}`,
						}),
					});
				} else {
					showError();
				}
			} catch (err) {
				showError((err as Error).message);
			} finally {
				setIsRunning(false);
				setInput("");
			}
		},
		[projectPath, activeProjectId, parseInput, showError, t],
	);

	const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
			// Shift/Ctrl/Cmd+Enter → run as an interactive task.
			e.preventDefault();
			void runAsTask();
		} else if (e.key === "Enter") {
			e.preventDefault();
			void runCommand();
		} else if (e.key === "Escape") {
			setOpen(false);
		} else if (e.key === "Tab" && filtered.length > 0) {
			// Autocomplete to the first suggestion.
			e.preventDefault();
			setInput(`/${filtered[0].name} `);
		}
	};

	const disabled = !projectPath || isRunning;

	const isCompact = variant === "compact";

	return (
		<div
			className={cn(
				"relative flex items-center gap-1",
				isCompact ? "gap-1" : "gap-2",
				className,
			)}
		>
			<Terminal
				className={cn("text-muted-foreground", isCompact ? "h-3.5 w-3.5" : "h-4 w-4")}
				aria-hidden
			/>
			<Input
				ref={inputRef}
				value={input}
				onChange={(e) => {
					setInput(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => {
					// Delay so a click on a suggestion still registers.
					globalThis.window.setTimeout(() => setOpen(false), 150);
				}}
				onKeyDown={handleKey}
				placeholder={t("tasks:kanban.quickCommand.placeholder")}
				disabled={disabled}
				className={cn(
					"font-mono text-xs",
					isCompact
						? "h-8 w-56 placeholder:text-xs"
						: "h-8 w-72 placeholder:text-xs",
					isCompact && "bg-muted/40 hover:bg-muted/60 transition-colors",
				)}
				aria-label={t("tasks:kanban.quickCommand.placeholder")}
				title={
					projectPath
						? t("tasks:kanban.quickCommand.hint")
						: t("tasks:kanban.quickCommand.missingProject")
				}
			/>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={disabled || input.trim().length === 0}
				onClick={() => void runCommand()}
				className="gap-1 text-muted-foreground hover:text-foreground"
				aria-label={t("tasks:kanban.quickCommand.buttonLabel")}
			>
				{isRunning ? (
					<>
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
						<span className="text-xs">
							{t("tasks:kanban.quickCommand.running")}
						</span>
					</>
				) : (
					<>
						<Play className="h-3.5 w-3.5" />
						<span className="sr-only">
							{t("tasks:kanban.quickCommand.buttonLabel")}
						</span>
					</>
				)}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={disabled || input.trim().length === 0}
				onClick={() => void runAsTask()}
				className="gap-1 text-muted-foreground hover:text-foreground"
				aria-label={t("tasks:kanban.quickCommand.runAsTaskLabel")}
				title={t("tasks:kanban.quickCommand.runAsTaskHint")}
			>
				<ListPlus className="h-3.5 w-3.5" />
				<span className="sr-only">
					{t("tasks:kanban.quickCommand.runAsTaskLabel")}
				</span>
			</Button>

			{open && filtered.length > 0 && (
				// A listbox needs options and a selected one; this menu has neither —
				// it is click-only, with no roving selection. `menu`/`menuitem`
				// describes what it actually is, and the items are direct children
				// as those roles require.
				<div
					role="menu"
					aria-label={t("tasks:kanban.quickCommand.ariaListLabel")}
					className="absolute top-9 left-5 z-50 max-h-72 w-96 overflow-auto rounded-md border bg-popover p-1 shadow-md"
				>
					{filtered.map((cmd) => (
							<button
								key={`${cmd.source}-${cmd.name}`}
								type="button"
								role="menuitem"
								onMouseDown={(e) => {
									// onMouseDown so it fires before the input's onBlur.
									e.preventDefault();
									void runCommand(cmd.name);
								}}
								className="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
							>
								<div className="flex w-full items-center justify-between gap-2">
									<code className="font-mono">/{cmd.name}</code>
									<span className="text-3xs uppercase text-muted-foreground">
										{cmd.source === "project"
											? t("tasks:kanban.quickCommand.sourceProject")
											: cmd.source === "user"
												? t("tasks:kanban.quickCommand.sourceUser")
												: t("tasks:kanban.quickCommand.sourceBuiltIn")}
									</span>
								</div>
								{cmd.description && (
									<span className="text-muted-foreground">
										{cmd.description}
									</span>
								)}
							</button>
					))}
				</div>
			)}
			{open && filtered.length === 0 && input.trim().length > 0 && (
				<div className="absolute top-9 left-5 z-50 w-72 rounded-md border bg-popover px-3 py-2 text-xs text-muted-foreground shadow-md">
					{t("tasks:kanban.quickCommand.noResults")}
				</div>
			)}
		</div>
	);
}

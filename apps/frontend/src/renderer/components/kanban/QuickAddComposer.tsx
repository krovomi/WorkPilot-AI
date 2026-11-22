import { Loader2, X } from "lucide-react";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import {
	CARD_TYPES,
	type CardType,
} from "../../../shared/constants/card-types";
import type { TaskPriority, TaskStatus } from "../../../shared/types";
import {
	defaultEngineProvider,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { useToast } from "../../hooks/use-toast";
import type { QuickAddColumn } from "../../lib/kanban-columns";
import { countRunning } from "../../lib/group-move";
import {
	buildQuickAddItems,
	QUICK_ADD_LABELS,
	quickAddLines,
	quickAddMetadata,
	splitsByDefault,
} from "../../lib/quick-add";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
	createTask,
	loadDraft,
	persistTaskStatus,
	saveDraft,
	useTaskStore,
} from "../../stores/task-store";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { CardTypeMenuItems, PriorityMenuItems } from "./CardChoiceMenuItems";
import { CARD_TYPE_ICONS } from "./CardTypeChip";

const BASE_COLOR = Object.fromEntries(
	CARD_TYPES.map((type) => [type.id, type.color]),
) as Record<CardType, string>;

// What was typed and picked, then closed without creating, per project and
// column, kept for the life of the window so reopening the composer gives it
// back (Escape, ✕ or a click elsewhere on the board).
interface UnsentCard {
	text: string;
	type: CardType | null;
	priority: TaskPriority | null;
}
const unsentCards = new Map<string, UnsentCard>();

// Layers the composer opens (its type and priority menus) live in portals:
// a press there is not a press outside.
const OWN_LAYERS = "[data-radix-popper-content-wrapper], [role='menu']";

interface QuickAddComposerProps {
	status: QuickAddColumn;
	onClose: () => void;
	/** Opens the full creation wizard, prefilled with what was typed. */
	onOpenWizard?: () => void;
}

/**
 * The quick-add box at the top of the Planification, File d'attente and
 * En cours columns. Enter creates and keeps the box open for the next card; a pasted
 * list makes one card per line. Design: docs/architecture/kanban-quick-edit.md.
 */
export function QuickAddComposer({
	status,
	onClose,
	onOpenWizard,
}: QuickAddComposerProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const { toast } = useToast();
	const projectId = useProjectStore(
		(s) => s.activeProjectId || s.selectedProjectId,
	);
	const projectProvider = useProjectStore(
		(s) =>
			s.projects.find(
				(p) => p.id === (s.activeProjectId || s.selectedProjectId),
			)?.settings?.provider,
	);
	// The slots of « En cours », as the board counts them.
	const maxParallelTasks = useProjectStore(
		(s) =>
			s.projects.find((p) => p.id === (s.activeProjectId || s.selectedProjectId))?.settings
				?.maxParallelTasks ?? 3,
	);
	const { settings } = useSettingsStore(
		useShallow((s) => ({ settings: s.settings })),
	);
	const draftKey = `${projectId ?? ""}:${status}`;
	const [unsent] = useState(() => unsentCards.get(draftKey));
	const [text, setText] = useState(unsent?.text ?? "");
	const [splitChoice, setSplitChoice] = useState<boolean | null>(null);
	const [type, setType] = useState<CardType | null>(unsent?.type ?? null);
	const [priority, setPriority] = useState<TaskPriority | null>(unsent?.priority ?? null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	const lineCount = quickAddLines(text).length;
	const split = lineCount > 1 && (splitChoice ?? splitsByDefault(text));
	const cardCount = split ? lineCount : text.trim() ? 1 : 0;

	useEffect(() => {
		unsentCards.set(draftKey, { text, type, priority });
	}, [draftKey, text, type, priority]);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const close = useCallback(() => {
		if (!busy) onClose();
	}, [busy, onClose]);

	// A press anywhere else closes the box; what was typed waits in it.
	useEffect(() => {
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Element;
			const root = rootRef.current as HTMLDivElement;
			if (root.contains(target) || target.closest(OWN_LAYERS)) return;
			close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [close]);

	const create = useCallback(async () => {
		if (!projectId || busy) return;
		const items = buildQuickAddItems(text, split);
		if (items.length === 0) return;
		setBusy(true);
		setError(null);
		const engine = seedEngine(
			settings,
			defaultEngineProvider(settings, projectProvider),
		);
		const metadata = quickAddMetadata({ engine, type, priority });
		let created = 0;
		let waiting = 0;
		try {
			for (const item of items) {
				const task = await createTask(projectId, item.title, item.description, {
					...metadata,
				});
				if (!task) break;
				created++;
				// Queued, it waits for a free slot like a card dropped there. Started,
				// it takes a free slot of « En cours », or waits in the queue too.
				let column: TaskStatus | null = status === "backlog" ? null : status;
				if (column === "in_progress" && countRunning(useTaskStore.getState().tasks) >= maxParallelTasks) {
					column = "queue";
					waiting++;
				}
				if (column) await persistTaskStatus(task.id, column);
			}
		} finally {
			setBusy(false);
		}
		if (created === items.length) {
			setText("");
			setSplitChoice(null);
			toast({
				title: t("tasks:kanban.quickAdd.created", {
					count: created,
					column: t(`tasks:columns.${status}`),
				}),
				description:
					waiting > 0
						? t("tasks:kanban.groupMove.queued", { count: waiting, slots: maxParallelTasks })
						: undefined,
			});
		} else {
			// Keep the lines that were not created, so a retry does not duplicate.
			if (split) setText(quickAddLines(text).slice(created).join("\n"));
			setError(t("tasks:kanban.quickAdd.createFailed"));
		}
		requestAnimationFrame(() => textareaRef.current?.focus());
	}, [
		projectId,
		busy,
		text,
		split,
		settings,
		projectProvider,
		type,
		priority,
		status,
		maxParallelTasks,
		toast,
		t,
	]);

	const openWizard = useCallback(() => {
		if (!projectId || !onOpenWizard) return;
		const typed = text.trim();
		if (typed) {
			const existing = loadDraft(projectId);
			saveDraft({
				projectId,
				title: "",
				category: "",
				complexity: "",
				impact: "",
				model: "",
				thinkingLevel: "",
				images: [],
				referencedFiles: [],
				...(existing ?? {}),
				description: typed,
				priority: priority ?? existing?.priority ?? "",
				savedAt: new Date(),
			});
			setText("");
		}
		onClose();
		onOpenWizard();
	}, [projectId, onOpenWizard, text, priority, onClose]);

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void create();
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
		}
	};

	const TypeIcon = type ? CARD_TYPE_ICONS[type] : null;
	const labels = QUICK_ADD_LABELS[status];
	const createLabel =
		cardCount > 1 ? t(`tasks:${labels.createMany}`, { count: cardCount }) : t(`tasks:${labels.create}`);

	return (
		<div
			ref={rootRef}
			className="kanban-quick-add relative rounded-xl border border-primary/60 bg-card p-2 shadow-md"
			data-quick-add={status}
		>
			{/* Close in the corner, away from the create button. */}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="absolute top-1.5 right-1.5 h-6 w-6 text-muted-foreground hover:text-foreground"
				onClick={close}
				aria-label={t("tasks:kanban.quickAdd.close")}
				title={t("tasks:kanban.quickAdd.close")}
			>
				<X className="h-3.5 w-3.5" />
			</Button>
			<textarea
				ref={textareaRef}
				value={text}
				onChange={(e) => {
					setText(e.target.value);
					setError(null);
				}}
				onKeyDown={handleKeyDown}
				rows={2}
				disabled={busy}
				aria-label={t("tasks:kanban.quickAdd.ariaLabel")}
				placeholder={t("tasks:kanban.quickAdd.placeholder")}
				className="block max-h-48 min-h-[2.75rem] w-full resize-none overflow-y-auto [field-sizing:content] bg-transparent py-0.5 pr-7 pl-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
			/>
			<div className="mt-1.5 flex flex-wrap items-center gap-1">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="kanban-quick-add-pill"
							aria-label={t("tasks:kanban.quickAdd.type")}
						>
							{TypeIcon && type ? (
								<TypeIcon
									className="h-3 w-3"
									style={{ color: BASE_COLOR[type] }}
									aria-hidden="true"
								/>
							) : null}
							{type
								? t(`tasks:cardType.values.${type}`)
								: t("tasks:kanban.quickAdd.type")}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
						<CardTypeMenuItems
							current={type}
							onSelect={setType}
							noneLabel={t("tasks:kanban.quickAdd.noType")}
							onSelectNone={() => setType(null)}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="kanban-quick-add-pill"
							aria-label={t("tasks:kanban.quickAdd.priority")}
						>
							{priority
								? t(`tasks:form.classification.values.priority.${priority}`)
								: t("tasks:kanban.quickAdd.priority")}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-44">
						<PriorityMenuItems
							current={priority}
							onSelect={setPriority}
							noneLabel={t("tasks:kanban.quickAdd.noPriority")}
							onSelectNone={() => setPriority(null)}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
				{lineCount > 1 && (
					<button
						type="button"
						className={cn("kanban-quick-add-pill", split && "is-on")}
						aria-pressed={split}
						onClick={() => setSplitChoice(!split)}
					>
						{t("tasks:kanban.quickAdd.splitLines", { count: lineCount })}
					</button>
				)}
			</div>
			{error && (
				<p role="alert" className="mt-1.5 text-xs text-destructive">
					{error}
				</p>
			)}
			<div className="mt-2 flex items-center gap-1.5">
				{onOpenWizard && (
					<button
						type="button"
						onClick={openWizard}
						className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						{t("tasks:kanban.quickAdd.moreOptions")}
					</button>
				)}
				<span className="flex-1" />
				<Button
					type="button"
					size="sm"
					className="h-7 px-3 text-xs"
					onClick={() => void create()}
					disabled={busy || cardCount === 0}
				>
					{busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
					{createLabel}
				</Button>
			</div>
			<p className="mt-1.5 text-2xs leading-snug text-muted-foreground">
				{t("tasks:kanban.quickAdd.hint")}
			</p>
		</div>
	);
}

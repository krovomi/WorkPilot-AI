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
import type { TaskPriority } from "../../../shared/types";
import {
	defaultEngineProvider,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { useToast } from "../../hooks/use-toast";
import type { QuickAddColumn } from "../../lib/kanban-columns";
import {
	buildQuickAddItems,
	quickAddLines,
	quickAddMetadata,
	splitsByDefault,
} from "../../lib/quick-add";
import { cn } from "../../lib/utils";
import { useProjectStore } from "../../stores/project-store";
import { useSettingsStore } from "../../stores/settings-store";
import {
	createTask,
	kickQueue,
	loadDraft,
	persistTaskStatus,
	saveDraft,
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

// Text typed and closed without creating, per project and column, kept for
// the life of the window so reopening the composer gives it back.
const unsentText = new Map<string, string>();

interface QuickAddComposerProps {
	status: QuickAddColumn;
	onClose: () => void;
	/** Opens the full creation wizard, prefilled with what was typed. */
	onOpenWizard?: () => void;
}

/**
 * The quick-add box at the top of the Planification and File d'attente
 * columns. Enter creates and keeps the box open for the next card; a pasted
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
	const { settings } = useSettingsStore(
		useShallow((s) => ({ settings: s.settings })),
	);
	const draftKey = `${projectId ?? ""}:${status}`;
	const [text, setText] = useState(() => unsentText.get(draftKey) ?? "");
	const [splitChoice, setSplitChoice] = useState<boolean | null>(null);
	const [type, setType] = useState<CardType | null>(null);
	const [priority, setPriority] = useState<TaskPriority | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const lineCount = quickAddLines(text).length;
	const split = lineCount > 1 && (splitChoice ?? splitsByDefault(text));
	const cardCount = split ? lineCount : text.trim() ? 1 : 0;

	useEffect(() => {
		unsentText.set(draftKey, text);
	}, [draftKey, text]);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const close = useCallback(() => {
		if (!busy) onClose();
	}, [busy, onClose]);

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
		try {
			for (const item of items) {
				const task = await createTask(projectId, item.title, item.description, {
					...metadata,
				});
				if (!task) break;
				created++;
				if (status === "queue") await persistTaskStatus(task.id, "queue");
			}
		} finally {
			setBusy(false);
		}
		if (status === "queue" && created > 0) kickQueue();
		if (created === items.length) {
			setText("");
			setSplitChoice(null);
			unsentText.delete(draftKey);
			toast({
				title: t("tasks:kanban.quickAdd.created", {
					count: created,
					column: t(`tasks:columns.${status}`),
				}),
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
		draftKey,
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
			unsentText.delete(draftKey);
		}
		onClose();
		onOpenWizard();
	}, [projectId, onOpenWizard, text, priority, draftKey, onClose]);

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
	let createLabel = t("tasks:kanban.quickAdd.create");
	if (cardCount > 1) {
		createLabel = t("tasks:kanban.quickAdd.createMany", { count: cardCount });
	} else if (status === "queue") {
		createLabel = t("tasks:kanban.quickAdd.queue");
	}

	return (
		<div
			className="kanban-quick-add rounded-xl border border-primary/60 bg-card p-2 shadow-md"
			data-quick-add={status}
		>
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
				className="block max-h-48 min-h-[2.75rem] w-full resize-none overflow-y-auto [field-sizing:content] bg-transparent px-1 py-0.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
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
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					onClick={close}
					aria-label={t("tasks:kanban.quickAdd.close")}
					title={t("tasks:kanban.quickAdd.close")}
				>
					<X className="h-3.5 w-3.5" />
				</Button>
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

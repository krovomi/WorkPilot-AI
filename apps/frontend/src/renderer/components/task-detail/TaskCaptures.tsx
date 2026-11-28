import {
	ArrowLeft,
	Camera,
	ExternalLink,
	ImageIcon,
	Loader2,
	RefreshCw,
	ShieldCheck,
	Upload,
	Undo2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	Task,
	TaskCaptureItem,
	TaskCaptureSide,
	TaskCapturesAction,
	TaskCapturesChoice,
	TaskCapturesSummary,
} from "../../../shared/types";
import { isServerTask } from "../../../shared/utils/task-split";
import { persistUpdateTask } from "../../stores/task-store";
import {
	CAPTURES_STATE_VARIANT,
	capturesState,
	hasScreens,
	replacedKinds,
} from "../task-captures/captures-state";
import { useCaptureImage } from "../task-captures/useCaptureImage";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { TaskVisualProof } from "./TaskVisualProof";
import { formatAppDateTime } from "@/lib/date-format";

type ChoiceValue = "project" | TaskCapturesChoice;
const CHOICES: readonly ChoiceValue[] = ["project", "always", "never"];

interface Zoomed {
	source: string;
	title: string;
}

function CaptureSideView({
	taskId,
	side,
	which,
	title,
	version,
	onZoom,
}: {
	readonly taskId: string;
	readonly side: TaskCaptureSide | undefined;
	readonly which: "before" | "after";
	readonly title: string;
	readonly version?: string;
	readonly onZoom: (zoomed: Zoomed) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const image = useCaptureImage(taskId, side?.available ? side.file : undefined, version);
	const heading = t(`tasks:captures.side.${which}`);
	const caption = t("tasks:captures.sideCaption", { label: title, side: heading });
	if (side?.available && image.source) {
		const source = image.source;
		return (
			<div className="min-w-0 space-y-1">
				<p className="text-xs font-medium text-muted-foreground">{heading}</p>
				<button
					type="button"
					className="block w-full overflow-hidden rounded border border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => onZoom({ source, title: caption })}
					aria-label={t("tasks:captures.zoom", { label: caption })}
				>
					<img src={source} alt={caption} className="w-full object-contain" />
				</button>
			</div>
		);
	}
	let placeholder: ReactNode;
	if (!side) placeholder = t("tasks:captures.noBefore");
	else if (!side.available) placeholder = t(`tasks:captures.status.${side.status}`);
	else if (image.failed) placeholder = t("tasks:captures.imageFailed");
	else placeholder = <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
	return (
		<div className="min-w-0 space-y-1">
			<p className="text-xs font-medium text-muted-foreground">{heading}</p>
			<div className="flex min-h-24 items-center justify-center rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
				{placeholder}
			</div>
		</div>
	);
}

function CaptureItemCard({
	taskId,
	item,
	version,
	onZoom,
}: {
	readonly taskId: string;
	readonly item: TaskCaptureItem;
	readonly version?: string;
	readonly onZoom: (zoomed: Zoomed) => void;
}) {
	const { t } = useTranslation(["tasks"]);
	const title = item.label || item.route || t("tasks:captures.untitled");
	const replaced = (item.after.replaced ?? 0) + (item.before?.replaced ?? 0);
	const kinds = [...new Set([...item.after.kinds, ...(item.before?.kinds ?? [])])];
	return (
		<div className="space-y-3 rounded-lg border border-border p-3" data-testid="capture-item">
			<div className="flex flex-wrap items-center gap-2">
				<p className="min-w-0 truncate text-sm font-medium">{title}</p>
				<Badge variant="muted">
					{t(`tasks:captures.platform.${item.platform}`, { defaultValue: item.platform })}
				</Badge>
				{item.variant === "mobile" && (
					<Badge variant="muted">{t("tasks:captures.variant.mobile")}</Badge>
				)}
				{!item.publishable && (
					<Badge variant="warning">{t("tasks:captures.keptOnTask")}</Badge>
				)}
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
				<CaptureSideView
					taskId={taskId}
					side={item.before}
					which="before"
					title={title}
					version={version}
					onZoom={onZoom}
				/>
				<CaptureSideView
					taskId={taskId}
					side={item.after}
					which="after"
					title={title}
					version={version}
					onZoom={onZoom}
				/>
			</div>
			{replaced > 0 && (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					{t("tasks:captures.itemFakes", {
						count: replaced,
						kinds: kinds
							.map((kind) => t(`tasks:captures.kinds.${kind}`, { defaultValue: kind }))
							.join(", "),
					})}
				</p>
			)}
		</div>
	);
}

/**
 * The Captures tab of a task: the screens it prepared for its pull request,
 * before and after, as the PR shows them (personal data replaced by fakes of
 * the same format), where they stand, and the buttons that publish, withdraw
 * or update them. A task without captures shows its visual proof instead.
 * Design: `docs/architecture/pr-captures.md` (« Dans l'app »).
 */
export function TaskCaptures({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const [summary, setSummary] = useState<TaskCapturesSummary | null>(task.captures ?? null);
	const [view, setView] = useState<"captures" | "proof">("captures");
	const [busy, setBusy] = useState<TaskCapturesAction | null>(null);
	const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
	const [zoomed, setZoomed] = useState<Zoomed | null>(null);
	const mounted = useRef(true);
	const server = isServerTask(task);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// The board's copy first, then the files as they are now.
	useEffect(() => {
		setSummary(task.captures ?? null);
	}, [task.captures]);
	useEffect(() => {
		const api = globalThis.electronAPI;
		if (typeof api?.getTaskCaptures !== "function") return;
		let cancelled = false;
		api
			.getTaskCaptures(task.id)
			.then((result) => {
				if (!cancelled && result.success) setSummary(result.data ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	const runAction = useCallback(
		async (action: TaskCapturesAction) => {
			const api = globalThis.electronAPI;
			if (typeof api?.runTaskCapturesAction !== "function") return;
			setBusy(action);
			setMessage(null);
			try {
				const result = await api.runTaskCapturesAction(task.id, action);
				if (!mounted.current) return;
				if (result.success && result.data) {
					if (result.data.captures) setSummary(result.data.captures);
					setMessage(
						result.data.noPr
							? { tone: "info", text: t("tasks:captures.noPrYet") }
							: { tone: "info", text: t(`tasks:captures.done.${action}`) },
					);
				} else {
					setMessage({
						tone: "error",
						text: t(`tasks:captures.errors.${result.error ?? "unknown"}`, {
							defaultValue: t("tasks:captures.errors.unknown"),
						}),
					});
				}
			} catch {
				if (mounted.current) {
					setMessage({ tone: "error", text: t("tasks:captures.errors.unknown") });
				}
			} finally {
				if (mounted.current) setBusy(null);
			}
		},
		[task.id, t],
	);

	const choice: ChoiceValue = task.metadata?.captures ?? "project";
	const saveChoice = (value: string) => {
		const next = CHOICES.find((c) => c === value);
		if (!next) return;
		void persistUpdateTask(task.id, {
			metadata: { captures: next === "project" ? undefined : next },
		});
	};

	const choicePicker = (
		<div className="flex flex-wrap items-center gap-2 text-xs">
			<span className="text-muted-foreground">{t("tasks:captures.choice.label")}</span>
			<Select value={choice} onValueChange={saveChoice}>
				<SelectTrigger className="h-7 w-auto min-w-40 text-xs" aria-label={t("tasks:captures.choice.label")}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{CHOICES.map((value) => (
						<SelectItem key={value} value={value}>
							{t(`tasks:captures.choice.${value}`)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);

	if (view === "proof" || !hasScreens(summary)) {
		return (
			<div className="flex h-full flex-col">
				<div className="shrink-0 space-y-2 border-b border-border px-5 py-3">
					{view === "proof" && hasScreens(summary) ? (
						<Button type="button" variant="ghost" size="sm" onClick={() => setView("captures")}>
							<ArrowLeft className="mr-2 h-4 w-4" />
							{t("tasks:captures.backToCaptures")}
						</Button>
					) : (
						<p className="flex items-start gap-2 text-sm text-muted-foreground">
							<Camera className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
							{summary
								? t(`tasks:captures.empty.${summary.needed ? "notYet" : summary.reason || "no-ui-files"}`, {
										defaultValue: t("tasks:captures.empty.no-ui-files"),
									})
								: t("tasks:captures.empty.none")}
						</p>
					)}
					{choicePicker}
				</div>
				<div className="min-h-0 flex-1">
					<TaskVisualProof task={task} />
				</div>
			</div>
		);
	}

	const state = capturesState(summary);
	const kinds = replacedKinds(summary);
	const prUrl = summary.sync?.prUrl || task.prUrl || task.metadata?.prUrl || "";
	const review = summary.publish === "review";
	const canAct = !server && summary.publish !== "never";

	return (
		<ScrollArea className="h-full">
			<div className="space-y-5 p-5">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold">{t("tasks:captures.title")}</h3>
							<Badge variant={CAPTURES_STATE_VARIANT[state]} data-testid="captures-state">
								{t(`tasks:captures.state.${state}`)}
							</Badge>
							<Badge variant="outline">
								{t("tasks:captures.count", { count: summary.items.length })}
							</Badge>
						</div>
						<p className="text-sm text-muted-foreground">
							{t(`tasks:captures.stateHint.${state}`)}
						</p>
						<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
							<ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							{kinds.length > 0
								? t("tasks:captures.fakesReplaced", {
										kinds: kinds
											.map((kind) => t(`tasks:captures.kinds.${kind}`, { defaultValue: kind }))
											.join(", "),
									})
								: t("tasks:captures.fakesNone")}
						</p>
						{summary.withheld > 0 && (
							<p className="text-xs text-warning">
								{t("tasks:captures.withheld", { count: summary.withheld })}
							</p>
						)}
						{summary.sync?.reason && (
							<p className="text-xs text-warning">
								{t(`tasks:captures.syncReason.${summary.sync.reason}`, {
									defaultValue: t("tasks:captures.syncReason.error"),
								})}
							</p>
						)}
						{summary.sync?.syncedAt && (
							<p className="text-xs text-muted-foreground">
								{t("tasks:captures.syncedAt", { date: formatAppDateTime(summary.sync.syncedAt) })}
							</p>
						)}
					</div>
					<div className="flex flex-wrap gap-2">
						{canAct && review && !summary.approved && summary.publishable > 0 && (
							<Button type="button" size="sm" onClick={() => void runAction("approve")} disabled={busy !== null}>
								{busy === "approve" ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<Upload className="mr-2 h-4 w-4" />
								)}
								{t("tasks:captures.actions.approve")}
							</Button>
						)}
						{canAct && review && summary.approved && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void runAction("withdraw")}
								disabled={busy !== null}
							>
								{busy === "withdraw" ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<Undo2 className="mr-2 h-4 w-4" />
								)}
								{t("tasks:captures.actions.withdraw")}
							</Button>
						)}
						{canAct && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void runAction("sync")}
								disabled={busy !== null}
							>
								{busy === "sync" ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<RefreshCw className="mr-2 h-4 w-4" />
								)}
								{t("tasks:captures.actions.sync")}
							</Button>
						)}
						{prUrl && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void globalThis.electronAPI.openExternal(prUrl)}
							>
								<ExternalLink className="mr-2 h-4 w-4" />
								{t("tasks:captures.actions.openPr")}
							</Button>
						)}
						<Button type="button" size="sm" variant="ghost" onClick={() => setView("proof")}>
							<ImageIcon className="mr-2 h-4 w-4" />
							{t("tasks:captures.actions.visualProof")}
						</Button>
					</div>
				</div>

				{choicePicker}
				{server && (
					<p className="text-xs text-muted-foreground">{t("tasks:captures.serverCard")}</p>
				)}
				{message && (
					<p
						className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
						role={message.tone === "error" ? "alert" : "status"}
					>
						{message.text}
					</p>
				)}

				<div className="space-y-4">
					{summary.items.map((item) => (
						<CaptureItemCard
							key={item.key || item.after.file}
							taskId={task.id}
							item={item}
							version={summary.generatedAt}
							onZoom={setZoomed}
						/>
					))}
				</div>
			</div>
			<Dialog open={zoomed !== null} onOpenChange={(open) => !open && setZoomed(null)}>
				<DialogContent className="max-w-[90vw]">
					<DialogTitle>{zoomed?.title}</DialogTitle>
					{zoomed && (
						<img src={zoomed.source} alt={zoomed.title} className="max-h-[80vh] w-full object-contain" />
					)}
				</DialogContent>
			</Dialog>
		</ScrollArea>
	);
}

/**
 * ContextGauge — how full the running agent session's context window is.
 *
 * A ring with the fill, a tick at the task's threshold and a colour by zone
 * (below / near / above). The tooltip gives the token counts and how they were
 * obtained; a badge shows the handoff being prepared in the background. A
 * click opens the live controls: mode and threshold (persisted to every spec
 * dir copy, read live by the backend — unlike the edit dialog, available while
 * the task runs), "Compact now" / "New thread" with the backend's
 * recommendation highlighted, and the last actions applied.
 *
 * `ContextGaugeMini` is the card's variant: ring + %, nothing to click.
 *
 * Both only read `context-usage-store`; the subscription lives in
 * `stores/global-listeners.ts`.
 */

import { CheckCircle2, Loader2, MessageSquarePlus, Shrink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ContextAction,
	ContextPolicy,
	Task,
	TaskContextActionAppliedEvent,
	TaskContextUsageEvent,
} from "../../../shared/types";
import {
	type ContextZone,
	contextZone,
	formatTokenCount,
	resolveContextPolicy,
	sameContextPolicy,
} from "../../../shared/utils/context-policy";
import { useToast } from "../../hooks/use-toast";
import { cn } from "../../lib/utils";
import {
	isContextActiveStatus,
	useContextUsageStore,
} from "../../stores/context-usage-store";
import { useTaskStore } from "../../stores/task-store";
import {
	ContextPolicyControls,
	ContextProviderHint,
} from "../task-form/ContextPolicyFields";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ProgressRing } from "../ui/progress-ring";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const ZONE_CLASS: Record<ContextZone, string> = {
	ok: "text-success",
	near: "text-warning",
	over: "text-destructive",
};

/** How long a manual request shows as pending without confirmation. */
const PENDING_TIMEOUT_MS = 90_000;
/** Debounce of the live policy writes (the slider fires on every step). */
const PERSIST_DEBOUNCE_MS = 400;

const EMPTY_HISTORY: TaskContextActionAppliedEvent[] = [];

function useTaskContext(task: Task) {
	const usage: TaskContextUsageEvent | undefined = useContextUsageStore(
		(s) => s.usage[task.id],
	);
	const history = useContextUsageStore((s) => s.history[task.id]) ?? EMPTY_HISTORY;
	const pending = useContextUsageStore((s) => s.pending[task.id]);
	return { usage, history, pending };
}

function taskProvider(task: Task): string | undefined {
	return task.metadata?.phaseProviders?.coding || task.metadata?.provider;
}

function formatTime(timestamp: string | undefined): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ContextGaugeMini({ task }: { task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const { usage } = useTaskContext(task);
	if (!usage || !isContextActiveStatus(task.status)) return null;
	// The backend's own figure: it re-reads the policy live, and the card is
	// memoised on fields that do not include the policy.
	const threshold = usage.thresholdPct;
	const percent = Math.round(usage.percent);
	const zone = contextZone(usage.percent, threshold);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className="inline-flex items-center gap-1 tabular-nums"
					data-testid="context-gauge-mini"
				>
					<ProgressRing
						value={usage.percent}
						size={14}
						stroke={2.5}
						indicatorClassName={ZONE_CLASS[zone]}
						markers={[threshold]}
						markerClassName="text-foreground/50"
						ariaLabel={t("tasks:contextManagement.gauge.ariaLabel", { percent })}
					/>
					<span className={cn("text-[10px] font-medium", ZONE_CLASS[zone])}>
						{percent}%
					</span>
				</span>
			</TooltipTrigger>
			<TooltipContent side="top" className="text-xs">
				{t("tasks:contextManagement.gauge.tooltip", {
					used: formatTokenCount(usage.usedTokens),
					window: formatTokenCount(usage.windowTokens),
					source: t(`tasks:contextManagement.source.${usage.source}`),
				})}
			</TooltipContent>
		</Tooltip>
	);
}

/** Live policy edit: local draft, debounced write to every spec dir copy. */
function useLivePolicy(task: Task) {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const stored = resolveContextPolicy(task.metadata);
	const [draft, setDraft] = useState<ContextPolicy>(stored);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latest = useRef<ContextPolicy>(stored);

	// Follow the stored policy when nothing is waiting to be written.
	const storedKey = JSON.stringify(stored);
	useEffect(() => {
		if (timer.current) return;
		const next = JSON.parse(storedKey) as ContextPolicy;
		latest.current = next;
		setDraft((current) => (sameContextPolicy(current, next) ? current : next));
	}, [storedKey]);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const persist = useCallback(
		async (policy: ContextPolicy) => {
			const api = globalThis.electronAPI;
			const result = await api?.updateContextPolicy?.(task.id, policy);
			if (result?.success) {
				const contextPolicy = result.data?.contextPolicy ?? policy;
				const current = useTaskStore
					.getState()
					.tasks.find((candidate) => candidate.id === task.id);
				useTaskStore.getState().updateTask(task.id, {
					metadata: { ...(current?.metadata ?? task.metadata), contextPolicy },
				});
			} else {
				toast({
					title: t("tasks:contextManagement.toast.saveFailed"),
					description: result?.error,
					variant: "destructive",
				});
			}
		},
		[task.id, task.metadata, toast, t],
	);

	const change = useCallback(
		(policy: ContextPolicy) => {
			setDraft(policy);
			latest.current = policy;
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => {
				timer.current = null;
				void persist(latest.current);
			}, PERSIST_DEBOUNCE_MS);
		},
		[persist],
	);

	return { draft, change };
}

interface ActionButtonProps {
	action: ContextAction;
	recommended: boolean;
	disabled: boolean;
	onClick: (action: ContextAction) => void;
}

function ActionButton({ action, recommended, disabled, onClick }: ActionButtonProps) {
	const { t } = useTranslation(["tasks"]);
	const Icon = action === "compact" ? Shrink : MessageSquarePlus;
	const label =
		action === "compact"
			? t("tasks:contextManagement.actions.compactNow")
			: t("tasks:contextManagement.actions.newThread");
	const tooltip =
		action === "compact"
			? t("tasks:contextManagement.actions.compactTooltip")
			: t("tasks:contextManagement.actions.newThreadTooltip");
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* The span keeps the tooltip working on a disabled button. */}
				<span className="flex-1">
					<Button
						type="button"
						size="sm"
						variant={recommended ? "default" : "outline"}
						disabled={disabled}
						onClick={() => onClick(action)}
						className="relative w-full gap-1.5"
						data-recommended={recommended || undefined}
						data-testid={`context-action-${action}`}
					>
						<Icon className="h-3.5 w-3.5" />
						{label}
						{recommended && (
							<span className="absolute -top-2 right-1 rounded bg-background px-1 text-[9px] font-semibold uppercase tracking-wide text-primary ring-1 ring-primary/40">
								{t("tasks:contextManagement.actions.recommended")}
							</span>
						)}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" className="max-w-[240px] text-xs">
				{tooltip}
			</TooltipContent>
		</Tooltip>
	);
}

function HistoryLine({ event }: { event: TaskContextActionAppliedEvent }) {
	const { t } = useTranslation(["tasks"]);
	const before = Math.round(event.beforePct);
	let text: string;
	if (event.action === "clear") {
		text = t("tasks:contextManagement.history.clear", { before });
	} else if (event.afterPct === null) {
		text = t("tasks:contextManagement.history.compactNoAfter", { before });
	} else {
		text = t("tasks:contextManagement.history.compact", {
			before,
			after: Math.round(event.afterPct),
		});
	}
	const Icon = event.action === "compact" ? Shrink : MessageSquarePlus;
	return (
		<li className="flex items-center gap-2 text-[11px]">
			<Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
			<span className="flex-1 truncate text-foreground">{text}</span>
			<span className="text-muted-foreground">
				{t(`tasks:contextManagement.history.${event.trigger}`)}
				{event.native ? ` · ${t("tasks:contextManagement.history.native")}` : ""}
			</span>
			<span className="tabular-nums text-muted-foreground">
				{formatTime(event.timestamp)}
			</span>
		</li>
	);
}

export function ContextGauge({ task }: { task: Task }) {
	const { t } = useTranslation(["tasks"]);
	const { usage, history, pending } = useTaskContext(task);
	const setPending = useContextUsageStore((s) => s.setPending);
	const active = isContextActiveStatus(task.status);
	const { draft, change } = useLivePolicy(task);
	const [error, setError] = useState<string | null>(null);

	// A request the backend never confirmed must not lock the buttons forever.
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => {
			if (useContextUsageStore.getState().pending[task.id] === pending) {
				setPending(task.id, null);
			}
		}, PENDING_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [pending, task.id, setPending]);

	const request = useCallback(
		async (action: ContextAction) => {
			setError(null);
			setPending(task.id, action);
			const result = await globalThis.electronAPI?.requestContextAction?.(
				task.id,
				action,
			);
			if (!result?.success) {
				setPending(task.id, null);
				setError(result?.error ?? "");
			}
		},
		[task.id, setPending],
	);

	if (!active && !usage) return null;

	const threshold = draft.thresholdPct;
	const percent = usage ? Math.round(usage.percent) : null;
	const zone = usage ? contextZone(usage.percent, threshold) : "ok";
	const tokensText = usage
		? t("tasks:contextManagement.gauge.tooltip", {
				used: formatTokenCount(usage.usedTokens),
				window: formatTokenCount(usage.windowTokens),
				source: t(`tasks:contextManagement.source.${usage.source}`),
			})
		: null;
	const handoffState = usage?.handoffState ?? "idle";
	const buttonsDisabled = !active || !!pending;

	return (
		<Popover>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={t("tasks:contextManagement.gauge.open")}
							data-testid="context-gauge"
						>
							<ProgressRing
								value={usage?.percent ?? 0}
								size={20}
								stroke={3}
								indicatorClassName={ZONE_CLASS[zone]}
								markers={[threshold]}
								ariaLabel={
									percent === null
										? undefined
										: t("tasks:contextManagement.gauge.ariaLabel", { percent })
								}
							/>
							<span
								className={cn(
									"text-xs font-medium tabular-nums",
									usage ? ZONE_CLASS[zone] : "text-muted-foreground",
								)}
							>
								{percent === null ? "–" : `${percent}%`}
							</span>
							{handoffState === "preparing" && (
								<Badge variant="info" className="gap-1 px-1.5 py-0 text-[10px]">
									<Loader2 className="h-2.5 w-2.5 animate-spin" />
									{t("tasks:contextManagement.handoff.preparing")}
								</Badge>
							)}
							{handoffState === "ready" && (
								<Badge variant="success" className="gap-1 px-1.5 py-0 text-[10px]">
									<CheckCircle2 className="h-2.5 w-2.5" />
									{t("tasks:contextManagement.handoff.ready")}
								</Badge>
							)}
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					<div>{tokensText ?? t("tasks:contextManagement.title")}</div>
					<div className="text-muted-foreground">
						{t("tasks:contextManagement.gauge.thresholdTooltip", {
							value: threshold,
							mode: t(`tasks:contextManagement.modes.${draft.mode}`),
						})}
					</div>
					{handoffState !== "idle" && (
						<div className="text-muted-foreground">
							{t(`tasks:contextManagement.handoff.${handoffState}Tooltip`)}
						</div>
					)}
				</TooltipContent>
			</Tooltip>

			<PopoverContent align="end" className="w-80 space-y-3 p-3">
				<div className="flex items-start gap-3">
					<ProgressRing
						value={usage?.percent ?? 0}
						size={44}
						stroke={4}
						indicatorClassName={ZONE_CLASS[zone]}
						markers={[threshold]}
						label={percent === null ? "–" : percent}
						labelClassName={cn("text-xs", usage ? ZONE_CLASS[zone] : "text-muted-foreground")}
					/>
					<div className="min-w-0 flex-1 space-y-0.5">
						<div className="text-sm font-semibold text-foreground">
							{t("tasks:contextManagement.title")}
						</div>
						{tokensText && (
							<div className="text-[11px] tabular-nums text-muted-foreground">
								{tokensText}
							</div>
						)}
						{usage && (
							<div className="truncate text-[11px] text-muted-foreground">
								{[usage.provider, usage.model].filter(Boolean).join(" · ")}
								{usage.phase
									? ` · ${t("tasks:contextManagement.gauge.phase", { phase: usage.phase })}`
									: ""}
							</div>
						)}
					</div>
				</div>

				<ContextPolicyControls
					value={draft}
					onChange={change}
					idPrefix={`gauge-${task.id}`}
					dense
				/>
				{usage ? (
					<p className="text-[11px] text-muted-foreground">
						{t(`tasks:contextManagement.provider.${usage.compactSupport}`, {
							provider: usage.provider,
						})}
					</p>
				) : (
					<ContextProviderHint provider={taskProvider(task)} />
				)}

				<div className="space-y-1.5 border-t border-border pt-3">
					<div className="flex gap-2 pt-1">
						<ActionButton
							action="compact"
							recommended={usage?.recommended === "compact"}
							disabled={buttonsDisabled}
							onClick={request}
						/>
						<ActionButton
							action="clear"
							recommended={usage?.recommended === "clear"}
							disabled={buttonsDisabled}
							onClick={request}
						/>
					</div>
					{pending && (
						<p className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							{t("tasks:contextManagement.actions.requested")}
						</p>
					)}
					{!active && (
						<p className="text-[11px] text-muted-foreground">
							{t("tasks:contextManagement.actions.notRunning")}
						</p>
					)}
					{error !== null && (
						<p className="text-[11px] text-destructive" role="alert">
							{t("tasks:contextManagement.actions.failed", { error })}
						</p>
					)}
				</div>

				<div className="space-y-1.5 border-t border-border pt-3">
					<div className="text-xs font-medium text-foreground">
						{t("tasks:contextManagement.history.title")}
					</div>
					{history.length === 0 ? (
						<p className="text-[11px] text-muted-foreground">
							{t("tasks:contextManagement.history.empty")}
						</p>
					) : (
						<ul className="space-y-1">
							{history.slice(0, 5).map((event, index) => (
								<HistoryLine
									key={event.eventId ?? `${event.timestamp}-${index}`}
									event={event}
								/>
							))}
						</ul>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

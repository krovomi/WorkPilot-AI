import { AlertCircle, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AutomationReason,
	AutomationRule,
	AutomationTriggerType,
	AutomationsState,
	EngineTrio,
	TaskKind,
} from "../../../../shared/types";
import { TASK_KINDS } from "../../../../shared/types/task";
import {
	defaultEngineProvider,
	seedEngine,
} from "../../../../shared/utils/task-engine";
import { useConfiguredProviders } from "../../../hooks/useConfiguredProviders";
import { useAutomationsStore } from "../../../stores/automations-store";
import { useSettingsStore } from "../../../stores/settings-store";
import { loadTasks } from "../../../stores/task-store";
import { EngineTrioPicker } from "../../task-engine/EngineTrioPicker";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Separator } from "../../ui/separator";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";

interface AutomationsIntegrationProps {
	readonly projectId: string;
}

const TRIGGERS: AutomationTriggerType[] = ["issue_labeled", "ci_failed", "schedule", "pr_opened"];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
/** Reasons whose raw message says more than the translated line. */
const RAW_DETAIL = new Set<AutomationReason>([
	"source_failed",
	"card_failed",
	"not_started",
	"review_failed",
]);

interface Draft {
	id?: string;
	name: string;
	enabled: boolean;
	type: AutomationTriggerType;
	label: string;
	branch: string;
	base: string;
	time: string;
	days: number[];
	title: string;
	prompt: string;
	kind: TaskKind | "";
	engine: EngineTrio | null;
	draft: boolean;
	dailyCap: number;
}

function emptyDraft(): Draft {
	return {
		name: "",
		enabled: true,
		type: "issue_labeled",
		label: "",
		branch: "",
		base: "",
		time: "09:00",
		days: [1, 2, 3, 4, 5],
		title: "",
		prompt: "",
		kind: "",
		engine: null,
		draft: true,
		dailyCap: 3,
	};
}

function draftOf(rule: AutomationRule): Draft {
	const draft = emptyDraft();
	const trigger = rule.trigger;
	return {
		...draft,
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		type: trigger.type,
		label: trigger.type === "issue_labeled" ? trigger.label : "",
		branch: trigger.type === "ci_failed" ? (trigger.branch ?? "") : "",
		base: trigger.type === "pr_opened" ? (trigger.base ?? "") : "",
		...(trigger.type === "schedule" && {
			time: trigger.time,
			days: trigger.days,
			title: trigger.title,
			prompt: trigger.prompt,
		}),
		kind: rule.kind ?? "",
		engine: rule.engine ?? null,
		draft: rule.draft,
		dailyCap: rule.dailyCap,
	};
}

function ruleInput(draft: Draft): Record<string, unknown> {
	const trigger =
		draft.type === "issue_labeled"
			? { type: draft.type, label: draft.label }
			: draft.type === "ci_failed"
				? { type: draft.type, branch: draft.branch }
				: draft.type === "pr_opened"
					? { type: draft.type, base: draft.base }
					: {
							type: draft.type,
							time: draft.time,
							days: draft.days,
							title: draft.title,
							prompt: draft.prompt,
						};
	return {
		...(draft.id && { id: draft.id }),
		name: draft.name,
		enabled: draft.enabled,
		trigger,
		...(draft.kind && { kind: draft.kind }),
		...(draft.engine && { engine: draft.engine }),
		draft: draft.draft,
		dailyCap: draft.dailyCap,
	};
}

/**
 * Automations of a project: a rule turns an event into a Kanban card, or a
 * PR opened by someone else into a draft review. The main process checks
 * every rule and runs them; this panel only edits them and shows what they
 * did, failures included.
 */
export function AutomationsIntegration({ projectId }: AutomationsIntegrationProps) {
	const { t, i18n } = useTranslation(["settings", "tasks"]);
	const settings = useSettingsStore((s) => s.settings);
	const { providers } = useConfiguredProviders();
	const [state, setState] = useState<AutomationsState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);

	const apply = useCallback(
		(result: { success: boolean; data?: AutomationsState; error?: string }) => {
			if (result.success && result.data) {
				setState(result.data);
				setError(null);
				return true;
			}
			setError(result.error ?? t("automations.unknownError"));
			return false;
		},
		[t],
	);

	const refresh = useCallback(async () => {
		apply(await window.electronAPI.automations.get(projectId));
	}, [apply, projectId]);

	// Re-read on open and after every pass the main process announces
	// (setupAutomationsListeners counts them).
	const passes = useAutomationsStore((s) => s.passes[projectId] ?? 0);
	useEffect(() => {
		void passes;
		void refresh();
	}, [passes, refresh]);

	const time = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.language, {
				dateStyle: "short",
				timeStyle: "short",
			}),
		[i18n.language],
	);
	const weekday = useMemo(
		() => new Intl.DateTimeFormat(i18n.language, { weekday: "short" }),
		[i18n.language],
	);
	// 2023-01-01 was a Sunday: day `d` of the week is January 1 + d.
	const dayName = (day: number) => weekday.format(new Date(2023, 0, 1 + day));

	const save = async () => {
		if (!editing) return;
		setBusy(true);
		try {
			if (apply(await window.electronAPI.automations.save(projectId, ruleInput(editing)))) {
				setEditing(null);
			}
		} finally {
			setBusy(false);
		}
	};

	const toggle = async (rule: AutomationRule, enabled: boolean) => {
		apply(
			await window.electronAPI.automations.save(projectId, {
				...ruleInput(draftOf(rule)),
				enabled,
			}),
		);
	};

	const remove = async (rule: AutomationRule) => {
		apply(await window.electronAPI.automations.remove(projectId, rule.id));
	};

	const runNow = async () => {
		setBusy(true);
		try {
			if (apply(await window.electronAPI.automations.run(projectId))) {
				void loadTasks(projectId, { forceRefresh: true });
			}
		} finally {
			setBusy(false);
		}
	};

	const summary = (rule: AutomationRule) => {
		const trigger = rule.trigger;
		switch (trigger.type) {
			case "issue_labeled":
				return t("automations.summary.issue_labeled", { label: trigger.label });
			case "ci_failed":
				return t("automations.summary.ci_failed", {
					branch: trigger.branch || t("automations.mainBranch"),
				});
			case "schedule":
				return t("automations.summary.schedule", {
					time: trigger.time,
					days: trigger.days.map(dayName).join(", "),
				});
			case "pr_opened":
				return t("automations.summary.pr_opened", {
					base: trigger.base || t("automations.anyBranch"),
				});
		}
	};

	const engineSeed = (): EngineTrio =>
		seedEngine(settings, defaultEngineProvider(settings)).coding;

	return (
		<div className="space-y-6">
			<p className="text-sm text-muted-foreground">{t("automations.intro")}</p>

			{error && (
				<div
					role="alert"
					className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
				>
					<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
					<span>{error}</span>
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					onClick={() => setEditing(emptyDraft())}
					disabled={busy || editing !== null}
				>
					<Plus className="mr-1 h-4 w-4" />
					{t("automations.add")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => void runNow()}
					disabled={busy || !state?.rules.some((rule) => rule.enabled)}
				>
					<Play className="mr-1 h-4 w-4" />
					{t("automations.runNow")}
				</Button>
			</div>

			{editing && (
				<div className="space-y-4 rounded-lg border border-border p-4">
					<div className="space-y-2">
						<Label htmlFor="automation-name">{t("automations.fields.name")}</Label>
						<Input
							id="automation-name"
							value={editing.name}
							maxLength={80}
							onChange={(e) => setEditing({ ...editing, name: e.target.value })}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="automation-trigger">{t("automations.fields.trigger")}</Label>
						<select
							id="automation-trigger"
							className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
							value={editing.type}
							// A saved rule keeps its trigger type: its history is about that event.
							disabled={editing.id !== undefined}
							onChange={(e) =>
								setEditing({
									...editing,
									type: e.target.value as AutomationTriggerType,
									kind:
										e.target.value === "ci_failed" && !editing.kind
											? "bug_fix"
											: editing.kind,
								})
							}
						>
							{TRIGGERS.map((type) => (
								<option key={type} value={type}>
									{t(`automations.triggers.${type}`)}
								</option>
							))}
						</select>
					</div>

					{editing.type === "issue_labeled" && (
						<div className="space-y-2">
							<Label htmlFor="automation-label">{t("automations.fields.label")}</Label>
							<Input
								id="automation-label"
								value={editing.label}
								maxLength={50}
								placeholder="workpilot"
								onChange={(e) => setEditing({ ...editing, label: e.target.value })}
							/>
							<p className="text-xs text-muted-foreground">{t("automations.help.issue_labeled")}</p>
						</div>
					)}

					{editing.type === "ci_failed" && (
						<div className="space-y-2">
							<Label htmlFor="automation-branch">{t("automations.fields.branch")}</Label>
							<Input
								id="automation-branch"
								value={editing.branch}
								placeholder={t("automations.mainBranch")}
								onChange={(e) => setEditing({ ...editing, branch: e.target.value })}
							/>
							<p className="text-xs text-muted-foreground">{t("automations.help.ci_failed")}</p>
						</div>
					)}

					{editing.type === "pr_opened" && (
						<div className="space-y-2">
							<Label htmlFor="automation-base">{t("automations.fields.base")}</Label>
							<Input
								id="automation-base"
								value={editing.base}
								placeholder={t("automations.anyBranch")}
								onChange={(e) => setEditing({ ...editing, base: e.target.value })}
							/>
							<p className="text-xs text-muted-foreground">{t("automations.help.pr_opened")}</p>
						</div>
					)}

					{editing.type === "schedule" && (
						<div className="space-y-4">
							<div className="flex flex-wrap items-end gap-4">
								<div className="space-y-2">
									<Label htmlFor="automation-time">{t("automations.fields.time")}</Label>
									<Input
										id="automation-time"
										type="time"
										value={editing.time}
										onChange={(e) => setEditing({ ...editing, time: e.target.value })}
									/>
								</div>
								<fieldset className="space-y-2">
									<legend className="text-sm font-medium">{t("automations.fields.days")}</legend>
									<div className="flex flex-wrap gap-1">
										{WEEKDAYS.map((day) => {
											const on = editing.days.includes(day);
											return (
												<Button
													key={day}
													type="button"
													size="sm"
													variant={on ? "default" : "outline"}
													aria-pressed={on}
													onClick={() =>
														setEditing({
															...editing,
															days: on
																? editing.days.filter((d) => d !== day)
																: [...editing.days, day],
														})
													}
												>
													{dayName(day)}
												</Button>
											);
										})}
									</div>
								</fieldset>
							</div>
							<div className="space-y-2">
								<Label htmlFor="automation-title">{t("automations.fields.title")}</Label>
								<Input
									id="automation-title"
									value={editing.title}
									maxLength={200}
									onChange={(e) => setEditing({ ...editing, title: e.target.value })}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="automation-prompt">{t("automations.fields.prompt")}</Label>
								<Textarea
									id="automation-prompt"
									value={editing.prompt}
									rows={4}
									onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
								/>
								<p className="text-xs text-muted-foreground">{t("automations.help.schedule")}</p>
							</div>
						</div>
					)}

					<Separator />

					{editing.type === "pr_opened" ? (
						// No card: no kind, no engine, and a review is always a draft.
						<p className="text-xs text-muted-foreground">{t("automations.help.review")}</p>
					) : (
						<>
							<div className="space-y-2">
								<Label htmlFor="automation-kind">{t("automations.fields.kind")}</Label>
								<select
									id="automation-kind"
									className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
									value={editing.kind}
									onChange={(e) => setEditing({ ...editing, kind: e.target.value as TaskKind | "" })}
								>
									<option value="">{t("automations.kindAuto")}</option>
									{TASK_KINDS.map((kind) => (
										<option key={kind} value={kind}>
											{t(`tasks:kind.values.${kind}`)}
										</option>
									))}
								</select>
							</div>

							<div className="space-y-2">
								<div className="flex items-center justify-between gap-4">
									<Label htmlFor="automation-engine">{t("automations.fields.engine")}</Label>
									<Switch
										id="automation-engine"
										checked={editing.engine !== null}
										onCheckedChange={(on) =>
											setEditing({ ...editing, engine: on ? engineSeed() : null })
										}
									/>
								</div>
								{editing.engine ? (
									<EngineTrioPicker
										value={editing.engine}
										onChange={(trio) => setEditing((prev) => (prev ? { ...prev, engine: trio } : prev))}
										providers={providers}
										idPrefix="automation-engine"
									/>
								) : (
									<p className="text-xs text-muted-foreground">{t("automations.engineDefault")}</p>
								)}
							</div>

							<div className="space-y-2">
								<div className="flex items-center justify-between gap-4">
									<Label htmlFor="automation-draft">{t("automations.fields.draft")}</Label>
									<Switch
										id="automation-draft"
										checked={editing.draft}
										onCheckedChange={(draft) => setEditing({ ...editing, draft })}
									/>
								</div>
								<p className={editing.draft ? "text-xs text-muted-foreground" : "text-xs text-warning"}>
									{editing.draft ? t("automations.help.draft") : t("automations.help.noDraft")}
								</p>
							</div>
						</>
					)}

					<div className="space-y-2">
						<Label htmlFor="automation-cap">{t("automations.fields.dailyCap")}</Label>
						<Input
							id="automation-cap"
							type="number"
							min={1}
							max={20}
							value={editing.dailyCap}
							onChange={(e) =>
								setEditing({ ...editing, dailyCap: Number.parseInt(e.target.value, 10) || 1 })
							}
							className="w-24"
						/>
						<p className="text-xs text-muted-foreground">{t("automations.help.dailyCap")}</p>
					</div>

					<div className="flex gap-2">
						<Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
							{t("automations.save")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setEditing(null)}
							disabled={busy}
						>
							{t("automations.cancel")}
						</Button>
					</div>
				</div>
			)}

			{state && state.rules.length === 0 && !editing && (
				<p className="text-sm text-muted-foreground">{t("automations.empty")}</p>
			)}

			{state && state.rules.length > 0 && (
				<ul className="space-y-3">
					{state.rules.map((rule) => {
						const status = state.statuses[rule.id];
						return (
							<li key={rule.id} className="space-y-2 rounded-lg border border-border p-3">
								<div className="flex items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="font-medium text-sm">{rule.name}</div>
										<div className="text-xs text-muted-foreground">
											{summary(rule)}
											{" · "}
											{rule.trigger.type === "pr_opened"
												? t("automations.reviewDrafts")
												: rule.draft
													? t("automations.drafts")
													: t("automations.starts")}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<Switch
											checked={rule.enabled}
											aria-label={t("automations.enable", { name: rule.name })}
											onCheckedChange={(on) => void toggle(rule, on)}
										/>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											aria-label={t("automations.edit", { name: rule.name })}
											onClick={() => setEditing(draftOf(rule))}
											disabled={editing !== null}
										>
											<Pencil className="h-4 w-4" />
										</Button>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											aria-label={t("automations.delete", { name: rule.name })}
											onClick={() => void remove(rule)}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</div>
								</div>
								<div className="text-xs text-muted-foreground">
									{status?.lastRunAt
										? t("automations.status.lastRun", {
												at: time.format(new Date(status.lastRunAt)),
											})
										: t("automations.status.never")}
									{" · "}
									{t(
										rule.trigger.type === "pr_opened"
											? "automations.status.reviewsToday"
											: "automations.status.today",
										{ count: status?.createdToday ?? 0, cap: rule.dailyCap },
									)}
									{status && status.deferred > 0 && (
										<>
											{" · "}
											{t("automations.status.deferred", { count: status.deferred })}
										</>
									)}
								</div>
								{status?.lastError && (
									<p role="alert" className="text-xs text-destructive">
										{t(`automations.reasons.${status.lastError}`)}
										{status.lastErrorDetail && RAW_DETAIL.has(status.lastError) && (
											<span className="text-muted-foreground"> ({status.lastErrorDetail})</span>
										)}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{state && state.activity.length > 0 && (
				<div className="space-y-2">
					<h4 className="font-medium text-sm">{t("automations.activity")}</h4>
					<ul className="space-y-1 text-xs">
						{state.activity.slice(0, 20).map((entry) => (
							<li key={`${entry.at}-${entry.ruleId}-${entry.subject}-${entry.outcome}`}>
								<span className="text-muted-foreground">{time.format(new Date(entry.at))}</span>{" "}
								<span className="font-medium">{entry.ruleName}</span>{" "}
								{t(`automations.outcome.${entry.outcome}`, {
									subject: entry.subject,
									specId: entry.specId ?? "",
								})}
								{entry.reason && (
									<span className="text-muted-foreground">
										{" — "}
										{t(`automations.reasons.${entry.reason}`)}
										{entry.detail && RAW_DETAIL.has(entry.reason) && ` (${entry.detail})`}
									</span>
								)}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

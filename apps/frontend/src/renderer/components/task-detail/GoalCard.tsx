import { Target } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskGoal, TaskGoalStatus } from "../../../shared/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

export interface GoalCardProps {
	readonly task: Task;
	/** False while a run is going: the goal is read at the start of each pass. */
	readonly editable?: boolean;
}

type Variant = "success" | "destructive" | "warning";

export function goalStatusVariant(status: TaskGoalStatus): Variant {
	switch (status) {
		case "met":
			return "success";
		case "unmet":
		case "budget":
			return "warning";
		case "error":
		case "invalid":
			return "destructive";
	}
}

interface Draft {
	command: string;
	expectedExit: string;
	maxRounds: string;
	maxCostUsd: string;
	timeoutSeconds: string;
	protected: string;
}

const EMPTY: Draft = {
	command: "",
	expectedExit: "0",
	maxRounds: "",
	maxCostUsd: "",
	timeoutSeconds: "",
	protected: "",
};

function toDraft(goal: TaskGoal): Draft {
	return {
		command: goal.command,
		expectedExit: String(goal.expectedExit ?? 0),
		maxRounds: goal.maxRounds === undefined ? "" : String(goal.maxRounds),
		maxCostUsd: goal.maxCostUsd === undefined ? "" : String(goal.maxCostUsd),
		timeoutSeconds: goal.timeoutSeconds === undefined ? "" : String(goal.timeoutSeconds),
		protected: (goal.protected ?? []).join("\n"),
	};
}

/** An empty field is "not set"; anything else goes as a number for main to check. */
const numberOrUndefined = (text: string) => (text.trim() === "" ? undefined : Number(text));

export function draftToGoal(draft: Draft): TaskGoal {
	const protectedPaths = draft.protected
		.split(/[\n,]/)
		.map((p) => p.trim())
		.filter(Boolean);
	return {
		command: draft.command.trim(),
		expectedExit: numberOrUndefined(draft.expectedExit) ?? 0,
		maxRounds: numberOrUndefined(draft.maxRounds),
		maxCostUsd: numberOrUndefined(draft.maxCostUsd),
		timeoutSeconds: numberOrUndefined(draft.timeoutSeconds),
		...(protectedPaths.length > 0 && { protected: protectedPaths }),
	};
}

/**
 * Le mode objectif, en une carte.
 *
 * Une tâche est finie quand une commande le dit, pas quand le relecteur le
 * pense : `dotnet test` qui sort en 0, un script du dépôt, un benchmark. La
 * boucle QA continue tant que la commande échoue, dans un nombre de passes et
 * un plafond de dépense ; les chemins protégés (les tests, le script) ne
 * peuvent pas être modifiés pour obtenir le vert.
 *
 * L'objectif est écrit par le main dans un fichier qu'aucun agent ne peut
 * écrire. Le dernier verdict vient du plan (`task.goal`).
 */
export function GoalCard({ task, editable = true }: GoalCardProps) {
	const { t } = useTranslation(["tasks"]);
	const [goal, setGoal] = useState<TaskGoal | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const api = globalThis.electronAPI;
		if (typeof api?.getTaskGoal !== "function") return;
		let cancelled = false;
		void api
			.getTaskGoal(task.id)
			.then((result) => {
				if (cancelled || !result.success || !result.data) return;
				setGoal(result.data.goal);
				setLoadError(result.data.error ?? null);
			})
			.catch(() => {
				// The card stays empty; setting a goal still works.
			});
		return () => {
			cancelled = true;
		};
	}, [task.id]);

	const save = async (next: TaskGoal | null) => {
		setBusy(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI.setTaskGoal(task.id, next);
			if (!result.success) {
				setError(result.error ?? null);
				return;
			}
			setGoal(result.data?.goal ?? null);
			setLoadError(null);
			setDraft(null);
		} finally {
			setBusy(false);
		}
	};

	const verdict = task.goal;
	const field = (key: keyof Draft) => ({
		id: `goal-${key}-${task.id}`,
		value: draft?.[key] ?? "",
		disabled: busy,
		onChange: (event: { target: { value: string } }) =>
			setDraft((prev) => (prev ? { ...prev, [key]: event.target.value } : prev)),
	});

	return (
		<div className="rounded-lg border border-border bg-muted/20 p-3">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<Target className="h-4 w-4 shrink-0 text-primary" aria-hidden />
						<span className="text-sm font-medium">{t("tasks:goal.title")}</span>
						{verdict && goal && (
							<Badge variant={goalStatusVariant(verdict.status)} className="text-[10px]">
								{t(`tasks:goal.status.${verdict.status}`)}
							</Badge>
						)}
					</div>
					{!goal && !draft && (
						<p className="text-xs text-muted-foreground">{t("tasks:goal.description")}</p>
					)}
					{goal && !draft && (
						<>
							<code className="block break-all rounded bg-muted px-1.5 py-0.5 text-xs">
								{goal.command}
							</code>
							<p className="text-xs text-muted-foreground">
								{t("tasks:goal.summary", {
									exit: goal.expectedExit ?? 0,
									rounds: goal.maxRounds ?? t("tasks:goal.effortCap"),
									cost:
										goal.maxCostUsd === undefined
											? t("tasks:goal.noCap")
											: `$${goal.maxCostUsd.toFixed(2)}`,
								})}
							</p>
							{goal.protected && goal.protected.length > 0 && (
								<p className="text-xs text-muted-foreground">
									{t("tasks:goal.protectedList", { list: goal.protected.join(", ") })}
								</p>
							)}
							{verdict && <p className="text-xs">{verdict.reason}</p>}
							{typeof verdict?.spentUsd === "number" && (
								<p className="text-xs text-muted-foreground">
									{t(verdict.spendComplete === false ? "tasks:goal.spentFloor" : "tasks:goal.spent", {
										amount: verdict.spentUsd.toFixed(2),
									})}
								</p>
							)}
						</>
					)}
					{loadError && !draft && (
						<p className="text-xs text-destructive">
							{t("tasks:goal.unreadable", { error: loadError })}
						</p>
					)}
				</div>
				{editable && !draft && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setError(null);
							setDraft(goal ? toDraft(goal) : EMPTY);
						}}
					>
						{goal ? t("tasks:goal.edit") : t("tasks:goal.set")}
					</Button>
				)}
			</div>

			{draft && (
				<form
					className="mt-3 space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void save(draftToGoal(draft));
					}}
				>
					<div className="space-y-1">
						<Label htmlFor={`goal-command-${task.id}`} className="text-xs">
							{t("tasks:goal.fields.command")}
						</Label>
						<Input {...field("command")} placeholder="dotnet test" className="font-mono text-xs" />
						<p className="text-[11px] text-muted-foreground">{t("tasks:goal.fields.commandHint")}</p>
					</div>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{(["expectedExit", "maxRounds", "maxCostUsd", "timeoutSeconds"] as const).map((key) => (
							<div key={key} className="space-y-1">
								<Label htmlFor={`goal-${key}-${task.id}`} className="text-xs">
									{t(`tasks:goal.fields.${key}`)}
								</Label>
								<Input {...field(key)} inputMode="decimal" className="text-xs" />
							</div>
						))}
					</div>
					<div className="space-y-1">
						<Label htmlFor={`goal-protected-${task.id}`} className="text-xs">
							{t("tasks:goal.fields.protected")}
						</Label>
						<Textarea {...field("protected")} rows={2} placeholder="tests/**" className="font-mono text-xs" />
						<p className="text-[11px] text-muted-foreground">{t("tasks:goal.fields.protectedHint")}</p>
					</div>
					{error && <p className="text-xs text-destructive">{error}</p>}
					<div className="flex flex-wrap justify-end gap-2">
						{goal && (
							<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
								{t("tasks:goal.remove")}
							</Button>
						)}
						<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
							{t("tasks:goal.cancel")}
						</Button>
						<Button type="submit" size="sm" disabled={busy || !draft.command.trim()}>
							{t("tasks:goal.save")}
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}

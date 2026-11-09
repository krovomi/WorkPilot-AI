import { HardDrive, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PurgeCandidate, PurgeOutcome } from "../../../shared/types/worktree-purge";
import { loadTasks } from "../../stores/task-store";
import { CharterButton, Chip, Notice } from "../charter";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

/** "1,4 Go" / "1.4 GB", in the app's language. */
export function formatBytes(bytes: number, locale: string): string {
	const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit: units[unit],
		unitDisplay: "short",
		maximumFractionDigits: unit === 0 ? 0 : 1,
	}).format(value);
}

type Phase =
	| { readonly kind: "loading" }
	| { readonly kind: "ready"; readonly candidates: PurgeCandidate[] }
	| { readonly kind: "purging"; readonly candidates: PurgeCandidate[] }
	| { readonly kind: "done"; readonly outcomes: PurgeOutcome[] }
	| { readonly kind: "failed"; readonly message: string };

/**
 * « Purger »: the worktrees of the board whose work is over (PR merged, card
 * done, archived or abandoned), the room they take, and their removal with
 * their local branch. A worktree with changes that are not committed is
 * shown and kept. Merged PRs are purged without asking
 * (main/worktree-purge/merged-watch.ts); this is for the rest.
 */
export function WorktreePurgeButton({ projectId }: { readonly projectId: string }) {
	const { t, i18n } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(false);
	const [phase, setPhase] = useState<Phase>({ kind: "loading" });
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const size = (bytes: number) => formatBytes(bytes, i18n.language);

	const load = async () => {
		setPhase({ kind: "loading" });
		const result = await globalThis.electronAPI.listPurgeableWorktrees(projectId);
		if (!result.success || !result.data) {
			setPhase({ kind: "failed", message: result.error || t("tasks:purge.failed") });
			return;
		}
		setSelected(new Set(result.data.filter((c) => !c.dirty).map((c) => c.specId)));
		setPhase({ kind: "ready", candidates: result.data });
	};

	const purge = async (candidates: PurgeCandidate[]) => {
		setPhase({ kind: "purging", candidates });
		const result = await globalThis.electronAPI.purgeWorktrees(projectId, [...selected]);
		if (!result.success || !result.data) {
			setPhase({ kind: "failed", message: result.error || t("tasks:purge.failed") });
			return;
		}
		setPhase({ kind: "done", outcomes: result.data });
	};

	// The board reloads once the dialog is closed: a reload while it is open
	// can show the board's skeleton, which unmounts the dialog and its result.
	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next && phase.kind === "done") void loadTasks(projectId, { forceRefresh: true });
	};

	const toggle = (specId: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(specId)) next.delete(specId);
			else next.add(specId);
			return next;
		});

	const candidates = phase.kind === "ready" || phase.kind === "purging" ? phase.candidates : [];
	const chosenBytes = candidates
		.filter((c) => selected.has(c.specId))
		.reduce((sum, c) => sum + c.bytes, 0);

	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="h-8 gap-2 rounded-full text-muted-foreground transition-colors hover:text-foreground"
				title={t("tasks:purge.buttonTitle")}
				onClick={() => {
					setOpen(true);
					void load();
				}}
				data-testid="worktree-purge-button"
			>
				<HardDrive className="h-4 w-4" aria-hidden="true" />
				{t("tasks:purge.button")}
			</Button>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="max-w-2xl" data-testid="worktree-purge-dialog">
					<DialogHeader>
						<DialogTitle>{t("tasks:purge.title")}</DialogTitle>
						<DialogDescription>{t("tasks:purge.description")}</DialogDescription>
					</DialogHeader>

					{phase.kind === "loading" && <p className="text-sm">{t("tasks:purge.loading")}</p>}
					{phase.kind === "failed" && (
						<Notice tone="red" role="alert">
							{phase.message}
						</Notice>
					)}
					{phase.kind === "done" && (
						<Notice tone="green" role="status">
							{t("tasks:purge.done", {
								count: phase.outcomes.filter((o) => o.purged).length,
								size: size(phase.outcomes.reduce((sum, o) => sum + (o.purged ? o.bytes : 0), 0)),
							})}
							{phase.outcomes.some((o) => !o.purged) && (
								<span className="block">
									{t("tasks:purge.kept", { count: phase.outcomes.filter((o) => !o.purged).length })}
								</span>
							)}
						</Notice>
					)}
					{(phase.kind === "ready" || phase.kind === "purging") &&
						(candidates.length === 0 ? (
							<p className="text-sm text-muted-foreground">{t("tasks:purge.empty")}</p>
						) : (
							<ul className="max-h-80 space-y-2 overflow-y-auto">
								{candidates.map((c) => (
									<li key={c.specId} className="flex items-center gap-3 text-sm">
										<Checkbox
											checked={selected.has(c.specId)}
											disabled={c.dirty || phase.kind === "purging"}
											onCheckedChange={() => toggle(c.specId)}
											aria-label={c.title}
										/>
										<span className="min-w-0 flex-1 truncate" title={c.path}>
											{c.title}
										</span>
										<Chip tone={c.dirty ? "amber" : "muted"}>
											{c.dirty ? t("tasks:purge.dirty") : t(`tasks:purge.reason.${c.reason}`)}
										</Chip>
										<span className="w-20 text-right tabular-nums">{size(c.bytes)}</span>
									</li>
								))}
							</ul>
						))}

					{(phase.kind === "ready" || phase.kind === "purging") && candidates.length > 0 && (
						<div className="flex items-center justify-end gap-2 pt-2">
							<CharterButton
								variant="primary"
								icon={Trash2}
								busy={phase.kind === "purging"}
								disabled={selected.size === 0 || phase.kind === "purging"}
								onClick={() => void purge(candidates)}
							>
								{t("tasks:purge.confirm", { count: selected.size, size: size(chosenBytes) })}
							</CharterButton>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}

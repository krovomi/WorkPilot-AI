import { Check, GitMerge, Pin, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	MemoryConflict,
	MemoryConflictChoice,
	MemoryConflictOpinion,
	MemoryConflictSide,
} from "../../../../shared/types";
import { formatAppDateTime } from "../../../lib/date-format";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent } from "../../ui/card";
import { Textarea } from "../../ui/textarea";
import { actorLabel, errorLabel, shortPath } from "./lifecycle-labels";

interface ConflictResolverProps {
	readonly projectId: string;
	readonly conflict: MemoryConflict;
	readonly onResolved: () => void;
	/** False: an escalated pair waits for one of the maintainers. */
	readonly canArbitrate?: boolean;
	readonly maintainers?: string[];
}

function Side({
	side,
	label,
	onKeep,
	busy,
}: {
	readonly side: MemoryConflictSide;
	readonly label: string;
	readonly onKeep: () => void;
	readonly busy: boolean;
}) {
	const { t } = useTranslation(["context"]);
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border/60 p-3">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span className="font-medium text-foreground">{label}</span>
				{side.pinned && (
					<Badge variant="outline" className="text-xs">
						<Pin className="mr-1 h-3 w-3" />
						{t("context:lifecycle.conflicts.pinned")}
					</Badge>
				)}
				{side.confidence !== null && (
					<span>
						{t("context:lifecycle.conflicts.confidence", {
							value: side.confidence.toFixed(2),
						})}
					</span>
				)}
				{side.updated && (
					<span>
						{t("context:lifecycle.conflicts.updated", {
							date: formatAppDateTime(side.updated),
						})}
					</span>
				)}
			</div>
			<code className="truncate text-xs text-muted-foreground">{shortPath(side.path)}</code>
			<p className="whitespace-pre-wrap text-sm text-foreground">{side.text}</p>
			{side.agents.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("context:lifecycle.conflicts.agents", { agents: side.agents.join(", ") })}
				</p>
			)}
			<Button size="sm" variant="outline" className="mt-auto gap-1" disabled={busy} onClick={onKeep}>
				<Check className="h-3.5 w-3.5" />
				{t("context:lifecycle.conflicts.keep")}
			</Button>
		</div>
	);
}

/** Two memories side by side: keep one, write the canonical note, or dismiss. */
export function ConflictResolver({
	projectId,
	conflict,
	onResolved,
	canArbitrate = true,
	maintainers = [],
}: ConflictResolverProps) {
	const { t } = useTranslation(["context"]);
	const escalated = conflict.escalated;
	const [working, setBusy] = useState(false);
	// An escalated pair a maintainer settles: the backend refuses anyone else too.
	const busy = working || (!!escalated && !canArbitrate);
	const [error, setError] = useState<string | null>(null);
	const [writing, setWriting] = useState(false);
	const [draft, setDraft] = useState("");
	const [opinion, setOpinion] = useState<MemoryConflictOpinion | null>(null);
	const [asking, setAsking] = useState(false);

	const resolve = async (choice: MemoryConflictChoice, text = "") => {
		setBusy(true);
		setError(null);
		try {
			const result = await window.electronAPI.resolveMemoryConflict(
				projectId,
				conflict.id,
				choice,
				text,
			);
			if (result.success) onResolved();
			else setError(errorLabel(t, result.error));
		} catch {
			setError(errorLabel(t, undefined));
		} finally {
			setBusy(false);
		}
	};

	const ask = async () => {
		setAsking(true);
		setError(null);
		try {
			const result = await window.electronAPI.suggestMemoryResolution(projectId, conflict.id);
			if (result.success && result.data) setOpinion(result.data);
			else setError(errorLabel(t, result.error));
		} catch {
			setError(errorLabel(t, undefined));
		} finally {
			setAsking(false);
		}
	};

	return (
		<Card data-testid="memory-conflict">
			<CardContent className="space-y-3 pt-4">
				<div className="flex flex-wrap items-center gap-2">
					<Badge variant="outline" className="text-xs">
						{t(`context:lifecycle.conflicts.signal.${conflict.signal}`)}
					</Badge>
					{conflict.detail && (
						<code className="text-xs text-muted-foreground">{conflict.detail}</code>
					)}
				</div>
				{escalated && (
					<p className="text-xs text-warning" data-testid="memory-conflict-escalated">
						{t("context:lifecycle.conflicts.escalated", {
							date: formatAppDateTime(escalated.at),
							actor: actorLabel(t, escalated.actor, escalated.by),
						})}
						{!canArbitrate &&
							` ${t("context:lifecycle.conflicts.waitingMaintainer", { names: maintainers.join(", ") })}`}
					</p>
				)}
				<div className="flex flex-col gap-3 md:flex-row">
					<Side
						side={conflict.a}
						label={t("context:lifecycle.conflicts.sideA")}
						busy={busy}
						onKeep={() => resolve("a")}
					/>
					<Side
						side={conflict.b}
						label={t("context:lifecycle.conflicts.sideB")}
						busy={busy}
						onKeep={() => resolve("b")}
					/>
				</div>
				{opinion && (
					<div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs" data-testid="memory-conflict-opinion">
						<div className="font-medium text-foreground">
							{t("context:lifecycle.conflicts.opinionTitle")}
						</div>
						<div>
							{t(`context:lifecycle.conflicts.verdict.${opinion.verdict}`)}
							{" · "}
							{t(`context:lifecycle.conflicts.prefer.${opinion.prefer}`)}
						</div>
						{opinion.reason && <div className="italic text-muted-foreground">{opinion.reason}</div>}
						{opinion.canonical && (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 px-2"
								onClick={() => {
									setDraft(opinion.canonical);
									setWriting(true);
								}}
							>
								{t("context:lifecycle.conflicts.useDraft")}
							</Button>
						)}
					</div>
				)}
				{writing && (
					<div className="space-y-2">
						<Textarea
							value={draft}
							maxLength={4000}
							placeholder={t("context:lifecycle.conflicts.canonicalPlaceholder")}
							aria-label={t("context:lifecycle.conflicts.canonicalPlaceholder")}
							onChange={(event) => setDraft(event.target.value)}
						/>
						<div className="flex gap-2">
							<Button size="sm" disabled={busy || !draft.trim()} onClick={() => resolve("custom", draft)}>
								{t("context:lifecycle.conflicts.save")}
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setWriting(false)}>
								{t("context:lifecycle.conflicts.cancel")}
							</Button>
						</div>
					</div>
				)}
				<div className="flex flex-wrap gap-2">
					{!writing && (
						<Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={() => setWriting(true)}>
							<GitMerge className="h-3.5 w-3.5" />
							{t("context:lifecycle.conflicts.writeCanonical")}
						</Button>
					)}
					<Button size="sm" variant="ghost" className="gap-1" disabled={busy || asking} onClick={ask}>
						<Sparkles className="h-3.5 w-3.5" />
						{asking ? t("context:lifecycle.conflicts.asking") : t("context:lifecycle.conflicts.ask")}
					</Button>
					<Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => resolve("dismiss")}>
						<X className="h-3.5 w-3.5" />
						{t("context:lifecycle.conflicts.dismiss")}
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}

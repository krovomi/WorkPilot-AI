import { Scale } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BestOfNArbiterAxis,
	BestOfNArbiterMonth,
	BestOfNState,
	BestOfNStatus,
} from "../../../shared/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const AXES: BestOfNArbiterAxis[] = [
	"correctness",
	"security",
	"tests",
	"maintainability",
	"performance",
];
const MAX_QUESTION = 1000;
const MAX_THREAD = 10;

type Call = (
	action: () => Promise<{ success: boolean; data?: BestOfNStatus; error?: string }>,
) => Promise<boolean>;

export interface BestOfNArbiterPanelProps {
	readonly taskId: string;
	readonly state: BestOfNState;
	/** A step is running (in main or on the card): the buttons wait. */
	readonly busy: boolean;
	readonly call: Call;
}

/** "#2 · openai · gpt-x · high" for a variant's spec id, else the id itself. */
function variantLabel(state: BestOfNState, specId: string): string {
	const variant = state.variants.find((v) => v.specId === specId);
	if (!variant) return specId;
	const { provider, model } = variant.engine;
	return `#${variant.index} · ${provider} · ${model}`;
}

/**
 * Le verdict de l'arbitre, sous le classement d'un best-of-N.
 *
 * Les axes chiffrés restent ceux du tableau ; l'arbitre ne fait que conseiller :
 * la variante qu'il garderait ou une fusion fichier par fichier, une raison par
 * axe, les risques des variantes écartées et sa confiance. Une confiance basse,
 * une réponse invalide ou un arbitre injoignable laissent le choix à la
 * personne, sans verdict inventé. La personne peut contester le verdict.
 */
export function BestOfNArbiterPanel({ taskId, state, busy, call }: BestOfNArbiterPanelProps) {
	const { t } = useTranslation(["tasks"]);
	const [question, setQuestion] = useState("");
	const [metrics, setMetrics] = useState<BestOfNArbiterMonth[] | null>(null);
	const arbiter = state.arbiter;
	if (!arbiter) return null;

	const divergence = arbiter.divergence;
	const hasVerdict = arbiter.status === "done" || arbiter.status === "needs_human";
	const thread = arbiter.thread ?? [];
	const arbiterProvider = arbiter.engine?.provider;
	const sameProvider =
		hasVerdict &&
		Boolean(arbiterProvider) &&
		state.variants.some((v) => v.engine.provider === arbiterProvider);
	const canAsk =
		divergence?.reason !== "single_candidate" && divergence?.reason !== "changes_unknown";

	const ask = () => void call(() => globalThis.electronAPI.arbitrateBestOfN(taskId));

	const send = async (event: FormEvent) => {
		event.preventDefault();
		const text = question.trim();
		if (!text) return;
		const ok = await call(() => globalThis.electronAPI.challengeBestOfN(taskId, text));
		if (ok) setQuestion("");
	};

	const loadMetrics = async () => {
		const result = await globalThis.electronAPI.getBestOfNArbiterMetrics(taskId);
		setMetrics(result.success ? (result.data ?? []) : []);
	};

	return (
		<section className="space-y-2 rounded-md border border-border/60 bg-background/40 p-2">
			<div className="flex flex-wrap items-center gap-2">
				<Scale className="h-3.5 w-3.5 text-primary" aria-hidden />
				<span className="text-xs font-medium">{t("tasks:bestOfN.arbiter.title")}</span>
				<Badge variant="outline" className="text-3xs">
					{t(`tasks:bestOfN.arbiter.status.${arbiter.status}`)}
				</Badge>
				{arbiter.confidence && hasVerdict && (
					<Badge
						variant={arbiter.confidence === "low" ? "destructive" : "secondary"}
						className="text-3xs"
					>
						{t(`tasks:bestOfN.arbiter.confidence.${arbiter.confidence}`)}
					</Badge>
				)}
			</div>

			{divergence && (
				<p className="text-2xs text-muted-foreground">
					{t(`tasks:bestOfN.arbiter.reason.${divergence.reason}`, {
						max: divergence.max.toFixed(2),
						threshold: divergence.threshold.toFixed(2),
					})}
				</p>
			)}

			{arbiter.status === "needs_human" && (
				<p className="text-xs font-medium text-warning">{t("tasks:bestOfN.arbiter.yourCall")}</p>
			)}
			{arbiter.status === "invalid" && (
				<p className="text-xs text-muted-foreground">{t("tasks:bestOfN.arbiter.invalid")}</p>
			)}
			{arbiter.status === "unavailable" && (
				<p className="text-xs text-destructive">
					{t("tasks:bestOfN.arbiter.unavailable", { reason: arbiter.reason ?? "" })}
				</p>
			)}

			{hasVerdict && arbiter.choice && (
				<div className="space-y-2 text-xs">
					{arbiter.choice === "merge" ? (
						<div className="space-y-1">
							<p className="font-medium">{t("tasks:bestOfN.arbiter.merge")}</p>
							<table className="w-full text-left text-2xs">
								<thead className="text-muted-foreground">
									<tr>
										<th className="pr-2">{t("tasks:bestOfN.arbiter.mergeFile")}</th>
										<th>{t("tasks:bestOfN.arbiter.mergeFrom")}</th>
									</tr>
								</thead>
								<tbody>
									{(arbiter.merge ?? []).map((item) => (
										<tr key={item.file} className="border-t border-border/40">
											<td className="pr-2 font-mono">{item.file}</td>
											<td className="font-mono">{variantLabel(state, item.from)}</td>
										</tr>
									))}
								</tbody>
							</table>
							<p className="text-2xs text-muted-foreground">
								{t("tasks:bestOfN.arbiter.mergeNotApplied")}
							</p>
						</div>
					) : (
						<p className="font-medium">
							{t("tasks:bestOfN.arbiter.keeps", { variant: variantLabel(state, arbiter.choice) })}
						</p>
					)}
					{arbiter.equivalent && (
						<p className="text-2xs text-muted-foreground">{t("tasks:bestOfN.arbiter.equivalent")}</p>
					)}
					{arbiter.summary && <p>{arbiter.summary}</p>}
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
						{AXES.filter((axis) => arbiter.reasons?.[axis]).map((axis) => (
							<div key={axis} className="contents">
								<dt className="text-muted-foreground">{t(`tasks:bestOfN.arbiter.axes.${axis}`)}</dt>
								<dd>{arbiter.reasons?.[axis]}</dd>
							</div>
						))}
					</dl>
					{Object.entries(arbiter.risks ?? {})
						.filter(([, risks]) => risks.length > 0)
						.map(([specId, risks]) => (
							<div key={specId}>
								<p className="text-muted-foreground">
									{t("tasks:bestOfN.arbiter.risks", { variant: variantLabel(state, specId) })}
								</p>
								<ul className="list-disc pl-4">
									{risks.map((risk) => (
										<li key={risk}>{risk}</li>
									))}
								</ul>
							</div>
						))}
				</div>
			)}

			{sameProvider && arbiterProvider && (
				<p className="text-2xs text-warning">
					{t("tasks:bestOfN.arbiter.sameProvider", { provider: arbiterProvider })}
				</p>
			)}
			{arbiter.engine?.provider && (
				<p className="text-2xs text-muted-foreground">
					{t("tasks:bestOfN.arbiter.engine", {
						engine: [arbiter.engine.provider, arbiter.engine.model].filter(Boolean).join(" · "),
					})}
				</p>
			)}

			{thread.length > 0 && (
				<ol className="space-y-1 text-xs">
					{thread.map((entry) => (
						<li key={entry.at + entry.question} className="space-y-0.5">
							<p>
								<span className="font-medium">{t("tasks:bestOfN.arbiter.you")}</span>
								<span className="ml-1">{entry.question}</span>
							</p>
							<p className="text-muted-foreground">
								<span className="font-medium">{t("tasks:bestOfN.arbiter.arbiter")}</span>
								<span className="ml-1">{entry.answer}</span>
							</p>
						</li>
					))}
				</ol>
			)}

			{hasVerdict &&
				(thread.length >= MAX_THREAD ? (
					<p className="text-2xs text-muted-foreground">{t("tasks:bestOfN.arbiter.threadFull")}</p>
				) : (
					<form className="space-y-1" onSubmit={(event) => void send(event)}>
						<label htmlFor={`bon-question-${taskId}`} className="text-2xs text-muted-foreground">
							{t("tasks:bestOfN.arbiter.questionLabel")}
						</label>
						<Textarea
							id={`bon-question-${taskId}`}
							value={question}
							maxLength={MAX_QUESTION}
							rows={2}
							placeholder={t("tasks:bestOfN.arbiter.questionPlaceholder")}
							disabled={busy}
							onChange={(event) => setQuestion(event.target.value)}
						/>
						<div className="flex justify-end">
							<Button type="submit" size="sm" variant="outline" disabled={busy || !question.trim()}>
								{t("tasks:bestOfN.arbiter.send")}
							</Button>
						</div>
					</form>
				))}

			<div className="flex flex-wrap items-center justify-end gap-2">
				{canAsk && (
					<Button size="sm" variant="ghost" disabled={busy} onClick={ask}>
						{hasVerdict ? t("tasks:bestOfN.arbiter.askAgain") : t("tasks:bestOfN.arbiter.ask")}
					</Button>
				)}
				<Button size="sm" variant="ghost" onClick={() => void loadMetrics()}>
					{t("tasks:bestOfN.arbiter.metrics")}
				</Button>
			</div>
			{metrics !== null && (
				<ul className="text-2xs text-muted-foreground">
					{metrics.length === 0 ? (
						<li>{t("tasks:bestOfN.arbiter.noMetrics")}</li>
					) : (
						metrics.map((month) => (
							<li key={month.month}>
								{t("tasks:bestOfN.arbiter.metricsLine", {
									month: month.month,
									count: month.arbitrations,
									percent: month.followedPercent,
									merges: month.merges,
								})}
							</li>
						))
					)}
				</ul>
			)}
		</section>
	);
}

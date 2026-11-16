/**
 * The bisect of a CI/CD incident (#375): why the last commit may not be the
 * culprit, a button that runs the failing tests between the last green commit
 * and the failing one, each commit tested as it comes, and the verdict.
 *
 * The only thing typed here is a commit id, checked against its shape before
 * it is sent, and again by the main process and the runner.
 */
import type {
	BisectResult,
	BisectTriggers,
	Incident,
} from "@shared/types/self-healing";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSelfHealingStore } from "@/stores/self-healing-store";
import { CharterButton, Notice } from "../charter";
import { Input } from "../ui/input";

const COMMIT_ID = /^[0-9a-fA-F]{7,40}$/;
const RANGE_STATUSES = new Set(["ambiguous", "budget"]);

function Verdict({ result }: { readonly result: BisectResult }) {
	const { t } = useTranslation(["selfHealing"]);
	if (result.status === "found") {
		return (
			<Notice tone="green" role="status">
				{t("selfHealing:bisect.status.found")} <code>{result.first_bad.slice(0, 12)}</code>{" "}
				<span className="text-muted-foreground">{result.first_bad_subject}</span>
				{result.cached && <span className="wp-meta ml-2">{t("selfHealing:bisect.cached")}</span>}
			</Notice>
		);
	}
	if (RANGE_STATUSES.has(result.status)) {
		return (
			<Notice tone="amber" role="status">
				{t(`selfHealing:bisect.status.${result.status}`)}{" "}
				{result.candidates.slice(0, 8).map((sha) => (
					<code key={sha} className="mr-1">
						{sha.slice(0, 8)}
					</code>
				))}
			</Notice>
		);
	}
	return (
		<Notice tone="amber" role="status">
			{t(`selfHealing:bisect.status.${result.status}`, { reason: result.reason })}
		</Notice>
	);
}

export function BisectPanel({
	incident,
	projectPath,
}: {
	readonly incident: Incident;
	readonly projectPath: string;
}) {
	const { t } = useTranslation(["selfHealing"]);
	const run = useSelfHealingStore((s) => s.bisects[incident.id]);
	const startBisect = useSelfHealingStore((s) => s.startBisect);
	const data = incident.source_data;
	const [good, setGood] = useState(typeof data.last_green === "string" ? data.last_green : "");
	const triggers = data.bisect_triggers as BisectTriggers | undefined;
	const result = run?.result ?? (data.bisect as BisectResult | undefined);
	const goodIsValid = good === "" || COMMIT_ID.test(good);

	return (
		<div className="mt-2 border-t border-border pt-2" data-testid="bisect-panel">
			<h4 className="wp-kicker flex items-center gap-1.5">
				<GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
				{t("selfHealing:bisect.title")}
			</h4>
			{triggers?.fired && (
				<div className="mt-1 text-xs">
					<span className="wp-meta">{t("selfHealing:bisect.triggers")}</span>
					<ul className="list-disc pl-4">
						{triggers.reasons.map((reason) => (
							<li key={reason}>
								{t(`selfHealing:bisect.trigger.${reason}`, { lines: triggers.changed_lines })}
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="mt-2 flex items-center gap-2">
				<label className="wp-meta" htmlFor={`bisect-good-${incident.id}`}>
					{t("selfHealing:bisect.goodLabel")}
				</label>
				<Input
					id={`bisect-good-${incident.id}`}
					value={good}
					onChange={(event) => setGood(event.target.value.trim())}
					placeholder={t("selfHealing:bisect.goodPlaceholder")}
					aria-invalid={!goodIsValid}
					className="h-auto w-36 px-2 py-0.5 font-mono text-xs"
				/>
				<CharterButton
					size="sm"
					icon={GitBranch}
					busy={run?.running}
					disabled={run?.running || !goodIsValid}
					onClick={() => startBisect(projectPath, incident.id, good)}
				>
					{run?.running ? t("selfHealing:bisect.running") : t("selfHealing:bisect.start")}
				</CharterButton>
			</div>
			{!goodIsValid && <p className="mt-1 text-xs text-warning">{t("selfHealing:bisect.invalidSha")}</p>}
			{run && run.steps.length > 0 && (
				<div className="mt-2 text-xs" data-testid="bisect-steps">
					<span className="wp-meta">{t("selfHealing:bisect.tested", { count: run.steps.length })}</span>
					<ol className="mt-0.5 space-y-0.5">
						{run.steps.map((step) => (
							<li key={`${step.tested}-${step.sha}`} className="flex gap-2">
								<code>{step.sha.slice(0, 8)}</code>
								<span className="text-muted-foreground">{t(`selfHealing:bisect.role.${step.role}`)}</span>
								<span>{t(`selfHealing:bisect.outcome.${step.outcome}`)}</span>
							</li>
						))}
					</ol>
				</div>
			)}
			{run?.error && (
				<Notice tone="red" role="alert" className="mt-2">
					{t("selfHealing:bisect.error", { error: run.error })}
				</Notice>
			)}
			{result && !run?.running && (
				<div className="mt-2">
					<Verdict result={result} />
				</div>
			)}
		</div>
	);
}

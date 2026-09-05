import {
	AlertTriangle,
	Check,
	ChevronRight,
	Copy,
	Lightbulb,
	RotateCw,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	TestGenErrorCode,
	TestGenerationError,
} from "../../../shared/types/test-generation";
import { useTestGenerationStore } from "../../stores/test-generation-store";

/**
 * GenerationErrorPanel — what actually went wrong, and what to do about it.
 *
 * A failed run used to surface as a red step in the stepper and nothing else:
 * the message existed in the store but no tab rendered it, and the message
 * itself was "empty response" for every provider failure alike. This panel is
 * the other half of that fix — it reads the structured failure and lays it out
 * in the order a person needs it:
 *
 *   what broke → why it broke → what to do → the technical text, folded away.
 *
 * The technical block stays collapsed by default. It is the part that helps
 * when the hint does not, and the part that turns the panel into a wall of
 * traceback when it is not needed.
 */

/** Which lucide accent each code gets. Purely cosmetic; copy lives in i18n. */
const SEVERITY: Record<TestGenErrorCode, "hard" | "soft"> = {
	auth: "soft",
	rate_limit: "soft",
	quota: "soft",
	network: "soft",
	timeout: "soft",
	provider_unavailable: "hard",
	empty_response: "soft",
	file_not_found: "soft",
	write_failed: "hard",
	parse_failed: "hard",
	invalid_input: "soft",
	backend_missing: "hard",
	runner_crashed: "hard",
	no_output: "hard",
	unknown: "hard",
};

interface GenerationErrorPanelProps {
	/** Defaults to the store's current failure. */
	readonly error?: TestGenerationError | null;
	/** Hide the retry button where there is nothing to replay. */
	readonly showRetry?: boolean;
}

export function GenerationErrorPanel({
	error,
	showRetry = true,
}: GenerationErrorPanelProps) {
	const { t } = useTranslation(["testGeneration"]);
	const storeError = useTestGenerationStore((s) => s.errorDetail);
	const lastRun = useTestGenerationStore((s) => s.lastRun);
	const retryLastRun = useTestGenerationStore((s) => s.retryLastRun);
	const phase = useTestGenerationStore((s) => s.phase);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [copied, setCopied] = useState(false);

	const failure = error ?? storeError;
	if (!failure) return null;

	const code = failure.code ?? "unknown";
	// `defaultValue` keeps an unmapped code readable rather than blank: a missing
	// translation must never be the reason the user learns nothing.
	const title = t(`failure.codes.${code}.title`, {
		defaultValue: t("failure.codes.unknown.title"),
	});
	const hint = t(`failure.codes.${code}.hint`, {
		defaultValue: t("failure.codes.unknown.hint"),
	});
	const isHard = SEVERITY[code] === "hard";

	const facts: Array<{ label: string; value: string }> = [];
	if (failure.stage && failure.stage !== "done") {
		facts.push({
			label: t("failure.facts.stage"),
			value: t(`live.stages.${failure.stage}`, { defaultValue: failure.stage }),
		});
	}
	if (failure.provider) {
		facts.push({ label: t("failure.facts.provider"), value: failure.provider });
	}
	if (failure.model) {
		facts.push({ label: t("failure.facts.model"), value: failure.model });
	}
	if (typeof failure.exitCode === "number") {
		facts.push({
			label: t("failure.facts.exitCode"),
			value: String(failure.exitCode),
		});
	}

	/** A single pasteable block — the panel's content, not a screenshot of it. */
	const report = [
		`[${code}] ${title}`,
		failure.message,
		...facts.map((f) => `${f.label}: ${f.value}`),
		failure.details ? `\n${failure.details}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const handleCopy = () => {
		try {
			navigator.clipboard.writeText(report);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			// best-effort — clipboard may be unavailable
		}
	};

	return (
		<section
			// Announced, not just coloured: the failure arrives while the user is
			// watching a spinner elsewhere on the page.
			role="alert"
			aria-live="assertive"
			className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5"
		>
			<div className="flex items-start gap-3">
				<span
					className={[
						"mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg",
						isHard
							? "bg-destructive/15 text-destructive"
							: "bg-warning/15 text-warning",
					].join(" ")}
					aria-hidden="true"
				>
					<AlertTriangle className="h-4 w-4" />
				</span>
				<div className="flex min-w-0 flex-col gap-1">
					<h4 className="text-sm font-semibold text-foreground">{title}</h4>
					<p className="text-sm leading-relaxed text-muted-foreground">
						{failure.message}
					</p>
				</div>
			</div>

			{hint && (
				<div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5">
					<Lightbulb
						className="mt-0.5 h-3.5 w-3.5 flex-none text-primary"
						aria-hidden="true"
					/>
					<p className="text-[12.5px] leading-relaxed text-foreground/90">
						{hint}
					</p>
				</div>
			)}

			{facts.length > 0 && (
				<dl className="flex flex-wrap items-center gap-1.5">
					{facts.map((fact) => (
						<div
							key={fact.label}
							className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1"
						>
							<dt className="text-[10px] uppercase tracking-wider text-muted-foreground">
								{fact.label}
							</dt>
							<dd className="max-w-[16rem] truncate font-mono text-[11px] text-foreground">
								{fact.value}
							</dd>
						</div>
					))}
				</dl>
			)}

			{failure.details && (
				<div className="rounded-lg border border-border/60 bg-background/40">
					<div className="flex items-center gap-2 px-2 py-1.5">
						<button
							type="button"
							onClick={() => setDetailsOpen((open) => !open)}
							aria-expanded={detailsOpen}
							className="flex flex-1 items-center gap-1.5 rounded text-left text-[11.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronRight
								className={[
									"h-3.5 w-3.5 transition-transform",
									detailsOpen ? "rotate-90" : "",
								].join(" ")}
								aria-hidden="true"
							/>
							{t("failure.technicalDetails")}
						</button>
						<button
							type="button"
							onClick={handleCopy}
							className="flex flex-none items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted"
						>
							{copied ? (
								<Check className="h-3 w-3 text-emerald-400" aria-hidden="true" />
							) : (
								<Copy className="h-3 w-3" aria-hidden="true" />
							)}
							{copied ? t("failure.copied") : t("failure.copyReport")}
						</button>
					</div>
					{detailsOpen && (
						<pre className="m-0 max-h-52 overflow-auto border-t border-border/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
							{failure.details}
						</pre>
					)}
				</div>
			)}

			{showRetry && lastRun && (
				<button
					type="button"
					onClick={retryLastRun}
					disabled={phase === "generating" || phase === "analyzing"}
					className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
				>
					<RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
					{t("failure.retry")}
				</button>
			)}
		</section>
	);
}

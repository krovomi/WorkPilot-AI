import { Check, Copy } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { I18nIssue, I18nSeverity } from "../../../shared/types/i18n-agent";
import { Chip, Panel, type Tone } from "../charter";

export const SEVERITY_TONES: Record<I18nSeverity, Tone> = {
	error: "red",
	warning: "amber",
	info: "blue",
};

/** The message in the app's language, built from the issue's fields (the runner's own is English). */
export function issueMessage(t: (key: string, options?: Record<string, unknown>) => string, issue: I18nIssue, rtl: string[]): string {
	const values = {
		key: issue.key,
		locale: issue.locale,
		text: issue.text ?? "",
		locales: rtl.join(", "),
		defaultValue: issue.message,
	};
	if (issue.issueType === "missing_plural" && !issue.key) return t("messages.missing_plural_many", values);
	if (issue.issueType === "orphan_key" && issue.possibly) return t("messages.orphan_key_possibly", values);
	return t(`messages.${issue.issueType}`, values);
}

function issueSuggestion(t: (key: string, options?: Record<string, unknown>) => string, issue: I18nIssue): string {
	const values = {
		key: issue.proposedKey || issue.key,
		locale: issue.locale,
		text: issue.text ?? "",
		logical: issue.proposedValue ?? "",
		defaultValue: issue.suggestion,
	};
	if (issue.issueType === "hardcoded_string") return t(issue.reused ? "suggestions.reuse" : "suggestions.add", values);
	if (issue.issueType === "rtl_side" && !issue.proposedValue) return t("suggestions.rtl_side_generic", values);
	if (issue.issueType === "missing_plural" && !issue.key) return t("suggestions.missing_plural_many", values);
	return t(`suggestions.${issue.issueType}`, values);
}

function CopyButton({ value, label }: { readonly value: string; readonly label: string }): React.ReactElement {
	const { t } = useTranslation("i18nAgent");
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="wp-muted inline-flex items-center gap-1 text-xs hover:underline"
			aria-label={label}
			onClick={() => {
				navigator.clipboard
					?.writeText(value)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => undefined);
			}}
		>
			{copied ? <Check className="h-3 w-3" aria-hidden="true" /> : <Copy className="h-3 w-3" aria-hidden="true" />}
			{copied ? t("proposal.copied") : t("proposal.copy")}
		</button>
	);
}

/** One finding: its message, where it is, what to do, and the key to paste for a hard-coded string. */
export function I18nIssueCard({ issue, rtl }: { readonly issue: I18nIssue; readonly rtl: string[] }): React.ReactElement {
	const { t } = useTranslation("i18nAgent");
	const tone = SEVERITY_TONES[issue.severity];
	return (
		<Panel rail tone={tone}>
			<div className="flex flex-wrap items-center gap-2">
				<Chip tone={tone}>{t(`severity.${issue.severity}`)}</Chip>
				<span className="wp-meta">{t(`issueType.${issue.issueType}`, { defaultValue: issue.issueType })}</span>
				{issue.locale && (
					<Chip tone="muted" dot={false}>
						{issue.locale}
					</Chip>
				)}
				{issue.reused && <Chip tone="green">{t("proposal.reused")}</Chip>}
				{issue.possibly && <Chip tone="amber">{t("proposal.possibly")}</Chip>}
			</div>
			<p className="mt-1.5 text-sm">{issueMessage(t, issue, rtl)}</p>
			{issue.file && (
				<p className="wp-meta mt-1 font-mono">
					{issue.file}
					{issue.line ? `:${issue.line}` : ""}
				</p>
			)}
			<p className="wp-tone-green wp-ink mt-1 text-xs">{issueSuggestion(t, issue)}</p>
			{issue.issueType === "hardcoded_string" && issue.proposedKey && (
				<div className="mt-2 grid gap-1 rounded-md border border-border/60 p-2 text-xs">
					<div className="flex flex-wrap items-center gap-2">
						<span className="wp-meta">{t("proposal.key")}</span>
						<code className="font-mono">{issue.proposedKey}</code>
						<CopyButton value={issue.proposedKey} label={t("proposal.copyKey")} />
					</div>
					{issue.proposedValue && (
						<div className="flex flex-wrap items-center gap-2">
							<span className="wp-meta">{t("proposal.value")}</span>
							<code className="font-mono">{issue.proposedValue}</code>
						</div>
					)}
					{issue.snippet && (
						<div className="flex flex-wrap items-center gap-2">
							<span className="wp-meta">{t("proposal.snippet")}</span>
							<code className="font-mono">{issue.snippet}</code>
							<CopyButton value={issue.snippet} label={t("proposal.copySnippet")} />
						</div>
					)}
				</div>
			)}
		</Panel>
	);
}

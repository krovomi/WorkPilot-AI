/**
 * What a production incident groups (#372): how many reports were folded into
 * it and from which tools, its fingerprint, the priority it inherited from its
 * root cause, and the commits most likely to have caused it.
 */
import type { Incident, IncidentGroup, SuspectCommit } from "@shared/types/self-healing";
import { GitCommitHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Chip, Chips } from "../charter";

interface Inherited {
	commit: string;
	severity: string;
}

function readGroup(data: Record<string, unknown>): IncidentGroup | null {
	const group = data.group as IncidentGroup | undefined;
	return group && Array.isArray(group.sources) ? group : null;
}

export function IncidentGroupInfo({ incident }: { readonly incident: Incident }) {
	const { t } = useTranslation(["selfHealing"]);
	const data = incident.source_data;
	const group = readGroup(data);
	const fingerprint = typeof data.fingerprint === "string" ? data.fingerprint : "";
	const suspects = Array.isArray(data.suspect_commits)
		? (data.suspect_commits as SuspectCommit[]).slice(0, 3)
		: [];
	const inherited = data.inherited_from as Inherited | undefined;
	if (!group && !fingerprint) return null;

	return (
		<div className="mt-2 space-y-1 text-xs" data-testid="incident-group">
			{group && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="wp-meta">{t("selfHealing:groups.reports", { count: group.report_count })}</span>
					<span className="wp-meta">{t("selfHealing:groups.seenBy")}</span>
					<Chips>
						{group.sources.map((source) => (
							<Chip key={source} tone="blue" dot={false}>
								{source}
							</Chip>
						))}
					</Chips>
				</div>
			)}
			{fingerprint && (
				<div className="wp-meta">
					{t("selfHealing:groups.fingerprint")} <code>{fingerprint}</code>
				</div>
			)}
			{inherited?.commit && (
				<p className="text-warning">
					{t("selfHealing:groups.inherited", {
						commit: inherited.commit.slice(0, 8),
						severity: inherited.severity,
					})}
				</p>
			)}
			{suspects.length > 0 && (
				<div>
					<span className="wp-kicker">{t("selfHealing:groups.suspects")}</span>
					<ul className="mt-0.5 space-y-0.5">
						{suspects.map((suspect) => (
							<li key={suspect.sha} className="flex items-center gap-1.5">
								<GitCommitHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
								<code>{suspect.sha.slice(0, 8)}</code>
								<span className="truncate text-muted-foreground" title={suspect.subject}>
									{suspect.subject}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

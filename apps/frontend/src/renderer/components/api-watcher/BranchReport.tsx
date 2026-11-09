import { CheckCheck, Copy, GitBranch, ShieldAlert, Users } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	ChangeCategory,
	ContractChange,
	ContractCompareReport,
	ContractReportEntry,
} from "../../../shared/types/api-watcher";
import { CharterButton, Chip, Notice, Panel, Section, Stat, Stats, type Tone } from "../charter";

export const CATEGORY_TONES: Record<ChangeCategory, Tone> = {
	breaking: "red",
	potentially_breaking: "amber",
	non_breaking: "green",
};

export const CATEGORY_KEYS: Record<ChangeCategory, string> = {
	breaking: "breaking",
	potentially_breaking: "potentiallyBreaking",
	non_breaking: "nonBreaking",
};

const STATUS_TONES: Record<ContractCompareReport["status"], Tone> = {
	pass: "green",
	review: "amber",
	breaking: "red",
	unchecked: "muted",
};

interface Props {
	readonly report: ContractCompareReport;
	readonly guide: string;
	readonly ciWorkflow?: string;
}

/** Every contract compared with the target branch, with who uses what broke (#389). */
export function BranchReport({ report, guide, ciWorkflow }: Props): React.ReactElement {
	const { t } = useTranslation("apiWatcher");
	return (
		<>
			{report.unchecked ? (
				<Notice tone="amber" icon={ShieldAlert}>
					{t("branch.unchecked", { reason: report.unchecked })}
				</Notice>
			) : (
				<Notice tone={STATUS_TONES[report.status]} icon={GitBranch}>
					{t(`branch.status.${report.status}`, {
						target: report.target,
						base: report.base.slice(0, 12),
						count: report.unacknowledgedBreakingCount,
					})}
				</Notice>
			)}
			{report.registry.errors.length > 0 && (
				<Notice tone="amber" icon={Users}>
					{t("branch.registryErrors", {
						source: report.registry.source,
						errors: report.registry.errors.join(" · "),
					})}
				</Notice>
			)}
			<Stats>
				<Stat label={t("categories.breaking")} value={report.breakingCount} tone={report.breakingCount ? "red" : "muted"} />
				<Stat
					label={t("branch.unacknowledged")}
					value={report.unacknowledgedBreakingCount}
					tone={report.unacknowledgedBreakingCount ? "red" : "muted"}
				/>
				<Stat
					label={t("categories.potentiallyBreaking")}
					value={report.potentiallyBreakingCount}
					tone={report.potentiallyBreakingCount ? "amber" : "muted"}
				/>
				<Stat label={t("categories.nonBreaking")} value={report.nonBreakingCount} tone={report.nonBreakingCount ? "green" : "muted"} />
			</Stats>
			{report.contracts.map((entry) => (
				<ContractSection key={entry.path} entry={entry} />
			))}
			{guide && (
				<Section kicker={t("kickers.guide")} title={t("migrationGuide")}>
					<pre className="wp-code max-h-96 overflow-auto whitespace-pre-wrap text-xs">{guide}</pre>
				</Section>
			)}
			{ciWorkflow && <CiSection workflow={ciWorkflow} />}
		</>
	);
}

function ContractSection({ entry }: { readonly entry: ContractReportEntry }): React.ReactElement {
	const { t } = useTranslation("apiWatcher");
	const version =
		entry.oldVersion || entry.newVersion ? `${entry.oldVersion || "∅"} → ${entry.newVersion || "∅"}` : undefined;
	return (
		<Section
			kicker={t(`formats.${entry.format}`, { defaultValue: entry.format })}
			title={<span className="font-mono">{entry.path}</span>}
			meta={version}
			actions={<Chip tone={entry.unacknowledgedBreakingCount ? "red" : "blue"}>{t(`branch.contract.${entry.status}`)}</Chip>}
		>
			{entry.status === "unsupported" ? (
				<p className="wp-muted text-xs">
					{t("branch.unsupported", { added: entry.linesAdded, removed: entry.linesRemoved })}
				</p>
			) : (
				<div className="grid gap-2.5">
					{entry.changes.map((change) => (
						<ChangePanel key={`${change.changeType}-${change.path}`} change={change} />
					))}
				</div>
			)}
		</Section>
	);
}

export function ChangePanel({ change }: { readonly change: ContractChange }): React.ReactElement {
	const { t } = useTranslation("apiWatcher");
	const tone = CATEGORY_TONES[change.category] ?? "muted";
	return (
		<Panel rail tone={tone}>
			<div className="flex flex-wrap items-center gap-2">
				<Chip tone={tone}>{t(`categories.${CATEGORY_KEYS[change.category] ?? "nonBreaking"}`)}</Chip>
				<span className="wp-meta">{t(`changeTypes.${change.changeType}`, { defaultValue: change.changeType })}</span>
				{change.acknowledged && (
					<Chip tone="blue" dot={false}>
						{t("branch.acknowledged")}
					</Chip>
				)}
			</div>
			<p className="mt-1.5 text-sm">{change.description}</p>
			<p className="wp-meta mt-1 font-mono">{change.path}</p>
			{(change.oldValue || change.newValue) && (
				<p className="wp-meta mt-1 font-mono">
					{change.oldValue || "∅"} → {change.newValue || "∅"}
				</p>
			)}
			{change.consumers && change.consumers.length > 0 && (
				<ul className="mt-2 grid gap-1" data-testid="change-consumers">
					{change.consumers.map((consumer) => (
						<li key={consumer.name} className="flex flex-wrap items-center gap-2 text-xs">
							<Users className="h-3.5 w-3.5" aria-hidden="true" />
							<span className="wp-title">{consumer.name}</span>
							{consumer.contact && <span className="wp-meta">{consumer.contact}</span>}
							{consumer.files.length > 0 && (
								<span className="wp-meta truncate font-mono" title={consumer.files.join("\n")}>
									{consumer.files.length === 1
										? consumer.files[0]
										: t("branch.files", { first: consumer.files[0], more: consumer.files.length - 1 })}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
		</Panel>
	);
}

function CiSection({ workflow }: { readonly workflow: string }): React.ReactElement {
	const { t } = useTranslation("apiWatcher");
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(workflow);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	return (
		<Section
			kicker={t("ci.kicker")}
			title={t("ci.title")}
			description={t("ci.description")}
			actions={
				<CharterButton variant="ghost" icon={copied ? CheckCheck : Copy} onClick={() => void copy()}>
					{t(copied ? "ci.copied" : "ci.copy")}
				</CharterButton>
			}
		>
			<pre className="wp-code max-h-96 overflow-auto text-xs" data-testid="api-ci-workflow">
				{workflow}
			</pre>
		</Section>
	);
}

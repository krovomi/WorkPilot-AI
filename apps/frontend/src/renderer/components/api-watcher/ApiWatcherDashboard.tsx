import { AlertTriangle, BookmarkCheck, FileJson, GitCompare, RotateCcw, Square } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApiWatcherStore } from "../../stores/api-watcher-store";
import type { ChangeCategory, ContractDiff } from "../../../shared/types/api-watcher";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	ScanLine,
	Section,
	Stat,
	Stats,
} from "../charter";
import { Input } from "../ui/input";
import { BranchReport, CATEGORY_KEYS, CATEGORY_TONES, ChangePanel } from "./BranchReport";

interface ApiWatcherDashboardProps {
	readonly projectPath?: string;
}

/** OpenAPI, GraphQL and protobuf contracts compared with the target branch, or a saved baseline. */
export function ApiWatcherDashboard({ projectPath }: ApiWatcherDashboardProps): React.ReactElement {
	const { t } = useTranslation(["apiWatcher", "navigation"]);

	const phase = useApiWatcherStore((s) => s.phase);
	const status = useApiWatcherStore((s) => s.status);
	const result = useApiWatcherStore((s) => s.result);
	const error = useApiWatcherStore((s) => s.error);
	const startScan = useApiWatcherStore((s) => s.startScan);
	const cancelScan = useApiWatcherStore((s) => s.cancelScan);
	const reset = useApiWatcherStore((s) => s.reset);

	const isScanning = phase === "scanning";
	const [target, setTarget] = useState("");

	return (
		<ModuleStage scroll="page" data-testid="api-watcher-view">
			<ModuleHeader
				kicker={t("navigation:groups.toolbox")}
				title={t("apiWatcher:title")}
				description={t("apiWatcher:description")}
				icon={FileJson}
				tone="blue"
				actions={
					<>
						{result && !isScanning && (
							<CharterButton variant="ghost" icon={RotateCcw} onClick={reset}>
								{t("apiWatcher:actions.reset")}
							</CharterButton>
						)}
						{isScanning ? (
							<CharterButton variant="danger" icon={Square} onClick={() => cancelScan()}>
								{t("apiWatcher:actions.cancel")}
							</CharterButton>
						) : (
							<>
								<Input
									aria-label={t("apiWatcher:branch.targetLabel")}
									placeholder={t("apiWatcher:branch.targetPlaceholder")}
									className="h-8 w-44 font-mono text-xs"
									value={target}
									onChange={(e) => setTarget(e.target.value)}
								/>
								<CharterButton
									icon={BookmarkCheck}
									onClick={() => projectPath && startScan(projectPath, true)}
									disabled={!projectPath}
								>
									{t("apiWatcher:actions.saveBaseline")}
								</CharterButton>
								<CharterButton
									variant="primary"
									icon={GitCompare}
									onClick={() => projectPath && startScan(projectPath, false, target.trim())}
									disabled={!projectPath}
								>
									{t("apiWatcher:actions.compareBranch")}
								</CharterButton>
							</>
						)}
					</>
				}
			/>
			<Page className="max-w-none space-y-4">
				{!projectPath && (
					<Notice tone="amber" icon={AlertTriangle}>
						{t("apiWatcher:errors.noProject")}
					</Notice>
				)}
				{isScanning && <ScanLine label={status || t("apiWatcher:actions.scanning")} />}
				{phase === "error" && error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t("apiWatcher:errors.failed", { error })}
					</Notice>
				)}
				{result?.report ? (
					<BranchReport report={result.report} guide={result.migrationGuideMarkdown} ciWorkflow={result.ciWorkflow} />
				) : result?.diff ? (
					<ReportBody diff={result.diff} guide={result.migrationGuideMarkdown} summary={result.summary} />
				) : (
					!isScanning && (
						<EmptyStage icon={FileJson} tone="blue" title={t("apiWatcher:idleTitle")}>
							{t("apiWatcher:noData")}
						</EmptyStage>
					)
				)}
			</Page>
		</ModuleStage>
	);
}

function ReportBody({
	diff,
	guide,
	summary,
}: {
	readonly diff: ContractDiff;
	readonly guide: string;
	readonly summary: string;
}): React.ReactElement {
	const { t } = useTranslation("apiWatcher");
	const [category, setCategory] = useState<ChangeCategory | "all">("all");
	const changes = diff.changes.filter((c) => category === "all" || c.category === category);
	const counts: Record<ChangeCategory, number> = {
		breaking: diff.breakingCount,
		potentially_breaking: diff.potentiallyBreakingCount,
		non_breaking: diff.nonBreakingCount,
	};

	return (
		<>
			<Stats>
				{(Object.keys(counts) as ChangeCategory[]).map((c) => (
					<Stat
						key={c}
						label={t(`categories.${CATEGORY_KEYS[c]}`)}
						value={counts[c]}
						tone={counts[c] ? CATEGORY_TONES[c] : "muted"}
					/>
				))}
			</Stats>
			<Section
				kicker={t("kickers.changes")}
				title={
					diff.changes.length ? t("changesDetected", { count: diff.changes.length }) : t("noChanges")
				}
				meta={diff.format !== "unknown" ? t(`formats.${diff.format}`, { defaultValue: diff.format }) : undefined}
				description={summary || undefined}
			>
				{diff.changes.length > 0 && (
					<div className="wp-chips mb-3">
						<Chip tone="blue" pressed={category === "all"} onClick={() => setCategory("all")}>
							{t("allCategories")} <span className="font-mono">{diff.changes.length}</span>
						</Chip>
						{(Object.keys(counts) as ChangeCategory[])
							.filter((c) => counts[c] > 0)
							.map((c) => (
								<Chip key={c} tone={CATEGORY_TONES[c]} pressed={category === c} onClick={() => setCategory(c)}>
									{t(`categories.${CATEGORY_KEYS[c]}`)} <span className="font-mono">{counts[c]}</span>
								</Chip>
							))}
					</div>
				)}
				<div className="grid gap-2.5">
					{changes.map((change) => (
						<ChangePanel key={`${change.changeType}-${change.path}`} change={change} />
					))}
				</div>
			</Section>
			{guide && (
				<Section kicker={t("kickers.guide")} title={t("migrationGuide")}>
					<pre className="wp-code max-h-96 overflow-auto whitespace-pre-wrap text-xs">{guide}</pre>
				</Section>
			)}
		</>
	);
}

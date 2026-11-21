/**
 * #3.7 License Governance panel.
 *
 * Pick a policy preset, scan the project, see which dependencies have
 * conflicting licences and the suggested remediation. A licence comes from
 * the lock file, the installed copy or the public registries (unless the
 * project is strictly offline); one that none of them gives is listed apart,
 * "to check", rather than mixed with the real conflicts.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { LicenseScanReport } from "../../../preload/api/modules/phase35-features-api";
import { useLicenseStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { NativeSelect } from "../ui/native-select";
import { PanelShell } from "./_panel-shell";

interface LicensePanelProps {
	readonly projectPath: string;
}

const POLICIES = [
	{ value: "permissive_only", labelKey: "license.policyPermissive" },
	{ value: "open_source_friendly", labelKey: "license.policyOpen" },
	{ value: "saas_safe", labelKey: "license.policySaas" },
] as const;

type Conflict = LicenseScanReport["conflicts"][number];

function ConflictTable({ rows }: { rows: Conflict[] }) {
	const { t } = useTranslation("phase35");
	return (
		<table className="w-full text-sm border">
			<thead>
				<tr className="border-b bg-muted/40">
					<th className="text-left p-2">{t("license.colPackage")}</th>
					<th className="text-left p-2">{t("license.colLicense")}</th>
					<th className="text-left p-2">{t("license.colCategory")}</th>
					<th className="text-left p-2">{t("license.colRemediation")}</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((c) => (
					<tr key={`${c.dependency.ecosystem}:${c.dependency.name}`} className="border-b">
						<td className="p-2">
							<span className="font-mono">{c.dependency.name}</span>{" "}
							<span className="text-xs text-muted-foreground">
								{t(`license.ecosystems.${c.dependency.ecosystem}` as never, {
									defaultValue: c.dependency.ecosystem,
								})}
							</span>
						</td>
						<td className="p-2 font-mono text-xs">{c.dependency.declared_license ?? "—"}</td>
						<td className="p-2">
							{t(`license.categories.${c.category}` as never, { defaultValue: c.category })}
						</td>
						<td className="p-2 text-xs text-muted-foreground">
							{t(`license.remediations.${c.category}` as never, {
								defaultValue: c.remediation,
							})}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export function LicensePanel({ projectPath }: LicensePanelProps) {
	const { t } = useTranslation("phase35");
	const { phase, error, report, online, scan } = useLicenseStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			report: s.report,
			online: s.online,
			scan: s.scan,
		})),
	);
	const [policy, setPolicy] =
		useState<"permissive_only" | "open_source_friendly" | "saas_safe">("permissive_only");
	const [askRegistries, setAskRegistries] = useState(true);

	const isRunning = phase === "running";
	const conflicts = report?.conflicts.filter((c) => c.category !== "unknown") ?? [];
	const toCheck = report?.conflicts.filter((c) => c.category === "unknown") ?? [];
	const bySource = report?.summary.by_source ?? {};
	const byEcosystem = report?.summary.by_ecosystem ?? {};

	return (
		<PanelShell
			title={t("license.title")}
			subtitle={t("license.subtitle")}
			error={error}
			actions={
				<Button
					size="sm"
					onClick={() => scan(projectPath, policy, askRegistries)}
					disabled={isRunning || !projectPath}
				>
					{isRunning ? t("common.running") : t("license.scan")}
				</Button>
			}
		>
			<div className="space-y-3">
				<div className="grid gap-3 sm:grid-cols-2">
					<div>
						<label htmlFor="policy-select" className="block text-sm font-medium mb-1">
							{t("license.policy")}
						</label>
						<NativeSelect
							id="policy-select"
							value={policy}
							onChange={(e) => setPolicy(e.target.value as typeof policy)}
							className="w-full p-2 text-sm h-auto"
						>
							{POLICIES.map((p) => (
								<option key={p.value} value={p.value}>
									{t(p.labelKey as never)}
								</option>
							))}
						</NativeSelect>
					</div>
					<label
						htmlFor="license-online"
						className="flex items-start gap-2 self-end text-sm cursor-pointer"
					>
						<Checkbox
							id="license-online"
							checked={askRegistries}
							onCheckedChange={(v) => setAskRegistries(v === true)}
						/>
						<span>
							{t("license.askRegistries")}
							<span className="block text-xs text-muted-foreground">
								{t("license.askRegistriesHint")}
							</span>
						</span>
					</label>
				</div>
				{!projectPath && (
					<p className="text-sm text-muted-foreground">
						{t("common.projectPathRequired")}
					</p>
				)}
				{report && (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-3">
							<Badge
								className={
									conflicts.length > 0
										? "bg-destructive/20 text-destructive border-destructive/40"
										: toCheck.length > 0
											? "bg-warning/20 text-warning border-warning/40"
											: "bg-success/20 text-success border-success/40"
								}
							>
								{conflicts.length > 0
									? t("license.failed")
									: toCheck.length > 0
										? t("license.toCheckBadge")
										: t("license.passed")}
							</Badge>
							<span className="text-sm text-muted-foreground">
								{t("license.dependencies")}: {report.dependencies.length} ·{" "}
								{t("license.conflicts")}: {conflicts.length} · {t("license.toCheck")}:{" "}
								{toCheck.length}
							</span>
						</div>
						{report.dependencies.length === 0 && (
							<p className="text-sm text-muted-foreground">{t("license.noManifest")}</p>
						)}
						{Object.keys(byEcosystem).length > 0 && (
							<div className="flex flex-wrap gap-2 text-xs">
								{Object.entries(byEcosystem).map(([eco, count]) => (
									<Badge key={eco} variant="outline">
										{t(`license.ecosystems.${eco}` as never, { defaultValue: eco })} · {count}
									</Badge>
								))}
							</div>
						)}
						{Object.keys(bySource).length > 0 && (
							<p className="text-xs text-muted-foreground">
								{Object.entries(bySource)
									.map(([source, count]) =>
										t(`license.sources.${source}` as never, { count, defaultValue: source }),
									)
									.join(" · ")}
							</p>
						)}
						{online === false && toCheck.length > 0 && (
							<p className="text-xs text-muted-foreground">{t("license.offlineNote")}</p>
						)}
						{conflicts.length > 0 && <ConflictTable rows={conflicts} />}
						{toCheck.length > 0 && (
							<details open={conflicts.length === 0}>
								<summary className="cursor-pointer text-sm font-medium">
									{t("license.toCheckTitle", { count: toCheck.length })}
								</summary>
								<div className="mt-2">
									<ConflictTable rows={toCheck} />
								</div>
							</details>
						)}
					</div>
				)}
			</div>
		</PanelShell>
	);
}

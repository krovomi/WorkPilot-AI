/**
 * The Usage tab's figures (`usage.read`): a period, filters, and the views
 * the server computes for them. A platform administrator can switch to the
 * whole deployment. A name opens that person's sheet; a dormant account can be
 * deactivated by whoever manages members. Exports are CSV, recorded by the
 * server in the audit log.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageDailyRow,
	UsageDelivery,
	UsageExport,
	UsageModels,
	UsagePages,
	UsagePersonRow,
	UsagePresence,
	UsageProjectRow,
	UsageQuery,
	UsageSummary,
} from "@shared/types/server-usage";
import { DateField, Label, NativeSelect } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission, usePermissionsStore } from "@/stores/permissions-store";
import { PersonSheet } from "./PersonSheet";
import { useUsageView } from "./use-usage-view";
import { download, type PeriodPreset, periodOf } from "./usage-format";
import {
	DailyChart,
	DeliverySection,
	KeyFigures,
	ModelsTables,
	PagesTable,
	PeopleTable,
	PresenceSection,
	ProjectsTable,
	Section,
	Shown,
} from "./UsageSections";

const PRESETS: readonly PeriodPreset[] = ["7d", "30d", "month", "custom"];

interface Filters {
	user_id: string;
	group_id: string;
	project_id: string;
	provider: string;
	model: string;
}

const NO_FILTER: Filters = { user_id: "", group_id: "", project_id: "", provider: "", model: "" };

function Choice({
	id,
	label,
	value,
	options,
	onChange,
}: {
	readonly id: string;
	readonly label: string;
	readonly value: string;
	readonly options: ReadonlyArray<{ value: string; label: string }>;
	readonly onChange: (value: string) => void;
}) {
	const { t } = useTranslation("administration");
	return (
		<div className="space-y-1">
			<Label htmlFor={id}>{label}</Label>
			<NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)}>
				<option value="">{t("usage.dashboard.all")}</option>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</NativeSelect>
		</div>
	);
}

export function UsageDashboard() {
	const { t } = useTranslation("administration");
	const isPlatformAdmin = usePermissionsStore((s) => s.isPlatformAdmin);
	const canManage = usePermission("org.member.write");
	const members = useAdminStore((s) => s.members);
	const groups = useAdminStore((s) => s.groups);
	const projects = useAdminStore((s) => s.groupProjects);
	const loadMembers = useAdminStore((s) => s.loadMembers);
	const loadGroups = useAdminStore((s) => s.loadGroups);
	const loadProjects = useAdminStore((s) => s.loadGroupProjects);
	const setUserActive = useAdminStore((s) => s.setUserActive);

	const [preset, setPreset] = useState<PeriodPreset>("30d");
	const [custom, setCustom] = useState(() => periodOf("30d"));
	const [filters, setFilters] = useState<Filters>(NO_FILTER);
	const [platform, setPlatform] = useState(false);
	const [person, setPerson] = useState<string | null>(null);
	const [tick, setTick] = useState(0);
	const [exportError, setExportError] = useState<string | null>(null);

	useEffect(() => {
		void loadMembers();
		void loadGroups();
		void loadProjects();
	}, [loadMembers, loadGroups, loadProjects]);

	const period = preset === "custom" ? custom : periodOf(preset);
	const query = useMemo<UsageQuery>(() => {
		const asked: UsageQuery = { start: period.start, end: period.end, platform };
		for (const [key, value] of Object.entries(filters) as Array<[keyof Filters, string]>) {
			// The organization's people, groups and projects mean nothing platform-wide.
			if (value && (!platform || key === "provider" || key === "model")) asked[key] = value;
		}
		return asked;
	}, [period.start, period.end, filters, platform]);
	const engines = useUsageView<UsageModels>("models", {
		start: period.start,
		end: period.end,
		platform,
	});

	const summary = useUsageView<UsageSummary>("summary", query);
	const daily = useUsageView<UsageDailyRow[]>("daily", query);
	const people = useUsageView<UsagePersonRow[]>("people", query);
	const models = useUsageView<UsageModels>("models", query);
	const byProject = useUsageView<UsageProjectRow[]>("projects", query);
	const pages = useUsageView<UsagePages>("pages", query);
	const delivery = useUsageView<UsageDelivery>("delivery", query);
	const presence = useUsageView<UsagePresence>("presence", query, tick);

	const set = (key: keyof Filters) => (value: string) =>
		setFilters((current) => ({ ...current, [key]: value }));

	async function exportView(view: UsageExport) {
		const api = globalThis.electronAPI?.serverUsage;
		if (!api) return;
		const result = await api.exportUsage(view, query);
		if (result.ok) {
			setExportError(null);
			download(result.data, `workpilot-usage-${view}-${period.start}-${period.end}.csv`, "text/csv");
		} else setExportError(result.error);
	}

	async function deactivate(userId: string) {
		if (await setUserActive(userId, false)) setTick((n) => n + 1);
	}

	if (person) {
		return <PersonSheet personId={person} query={query} onBack={() => setPerson(null)} />;
	}

	const providers = [...new Set((engines.data?.models ?? []).map((m) => m.provider))].sort();
	const modelNames = [...new Set((engines.data?.models ?? []).map((m) => m.model))].sort();
	const own = (values: string[]) => values.map((v) => ({ value: v, label: v }));

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1">
					<Label htmlFor="usage-period">{t("usage.dashboard.period")}</Label>
					<NativeSelect
						id="usage-period"
						value={preset}
						onChange={(e) => setPreset(e.target.value as PeriodPreset)}
					>
						{PRESETS.map((p) => (
							<option key={p} value={p}>
								{t(`usage.dashboard.presets.${p}`)}
							</option>
						))}
					</NativeSelect>
				</div>
				{preset === "custom" && (
					<>
						<div className="space-y-1">
							<Label htmlFor="usage-start">{t("usage.dashboard.start")}</Label>
							<DateField
								id="usage-start"
								value={custom.start}
								onValueChange={(start) => setCustom((c) => ({ ...c, start }))}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="usage-end">{t("usage.dashboard.end")}</Label>
							<DateField
								id="usage-end"
								value={custom.end}
								onValueChange={(end) => setCustom((c) => ({ ...c, end }))}
							/>
						</div>
					</>
				)}
				{!platform && (
					<>
						<Choice
							id="usage-person"
							label={t("usage.dashboard.person")}
							value={filters.user_id}
							options={members.map((m) => ({ value: m.user_id, label: m.display_name || m.email }))}
							onChange={set("user_id")}
						/>
						<Choice
							id="usage-group"
							label={t("usage.dashboard.group")}
							value={filters.group_id}
							options={groups.map((g) => ({ value: g.id, label: g.name }))}
							onChange={set("group_id")}
						/>
						<Choice
							id="usage-project"
							label={t("usage.dashboard.project")}
							value={filters.project_id}
							options={projects.map((p) => ({ value: p.id, label: p.name }))}
							onChange={set("project_id")}
						/>
					</>
				)}
				<Choice
					id="usage-provider"
					label={t("usage.dashboard.provider")}
					value={filters.provider}
					options={own(providers)}
					onChange={set("provider")}
				/>
				<Choice
					id="usage-model"
					label={t("usage.dashboard.model")}
					value={filters.model}
					options={own(modelNames)}
					onChange={set("model")}
				/>
				{isPlatformAdmin && (
					<label className="flex h-9 items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={platform}
							onChange={(e) => setPlatform(e.target.checked)}
						/>
						{t("usage.dashboard.platform")}
					</label>
				)}
			</div>
			{exportError && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error: exportError })}
				</p>
			)}

			<Shown loaded={summary}>{(data) => <KeyFigures summary={data} />}</Shown>
			<Section title={t("usage.dashboard.dailyTitle")} exportAs="daily" onExport={exportView}>
				<Shown loaded={daily}>{(rows) => <DailyChart rows={rows} />}</Shown>
			</Section>
			<Section title={t("usage.dashboard.peopleTitle")} exportAs="people" onExport={exportView}>
				<Shown loaded={people}>{(rows) => <PeopleTable rows={rows} onOpen={setPerson} />}</Shown>
			</Section>
			<Section title={t("usage.dashboard.modelsTitle")} exportAs="models" onExport={exportView}>
				<Shown loaded={models}>{(report) => <ModelsTables report={report} />}</Shown>
			</Section>
			<Section title={t("usage.dashboard.projectsTitle")} exportAs="projects" onExport={exportView}>
				<Shown loaded={byProject}>{(rows) => <ProjectsTable rows={rows} />}</Shown>
			</Section>
			<Section title={t("usage.dashboard.deliveryTitle")} exportAs="failures" onExport={exportView}>
				<Shown loaded={delivery}>{(report) => <DeliverySection report={report} />}</Shown>
			</Section>
			<Section title={t("usage.dashboard.presenceTitle")}>
				<Shown loaded={presence}>
					{(report) => (
						<PresenceSection
							report={report}
							onOpen={setPerson}
							onDeactivate={canManage && !platform ? (id) => void deactivate(id) : undefined}
						/>
					)}
				</Shown>
			</Section>
			<Section title={t("usage.dashboard.pagesTitle")} exportAs="pages" onExport={exportView}>
				<Shown loaded={pages}>{(report) => <PagesTable report={report} />}</Shown>
			</Section>
		</div>
	);
}

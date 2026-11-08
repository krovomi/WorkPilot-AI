import { AlertTriangle, Home, Plus, RefreshCw, Save, ScanLine as ScanIcon, Trash2, WifiOff } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OfflineRuntimeInfo } from "../../../preload/api/modules/offline-mode-api";
import {
	canSaveOfflinePolicy,
	LOCAL_PROVIDERS as LOCAL_PROVIDER_IDS,
	modelsForProvider,
} from "../../stores/offline-mode-routing";
import { useOfflineModeStore } from "../../stores/offline-mode-store";
import {
	Bar,
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	Section,
	type Tone,
} from "../charter";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";

const LOCAL_PROVIDERS = new Set<string>(LOCAL_PROVIDER_IDS);

/** The three local runtimes, as the status reports them. */
const RUNTIMES = [
	["ollama", "Ollama"],
	["lmStudio", "LM Studio"],
	["llamaCpp", "llama.cpp"],
] as const;

const CONFIDENTIALITY_TONES: Record<string, Tone> = {
	local: "green",
	mixed: "amber",
	unknown: "muted",
};

function formatAge(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const min = Math.floor(seconds / 60);
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h${min % 60}m`;
}

interface Props {
	readonly projectPath?: string;
}

/** Local models only: which runtime answers each kind of task, and how strict the airgap is. */
export function OfflineModeSettings({ projectPath }: Props) {
	const { t } = useTranslation(["offlineMode", "navigation"]);
	const {
		status,
		policy,
		savedPolicy,
		report,
		catalog,
		loading,
		saving,
		scanning,
		error,
		dirty,
		loadAll,
		refreshStatus,
		scan,
		setAirgap,
		setDefaultProvider,
		setRouting,
		addRoutingRow,
		removeRoutingRow,
		save,
	} = useOfflineModeStore();

	const [newTask, setNewTask] = useState("");

	useEffect(() => {
		if (projectPath) void loadAll(projectPath);
	}, [projectPath, loadAll]);

	const modelsByProvider = (provider: string) => modelsForProvider(catalog, provider);
	const validPolicy = policy ? canSaveOfflinePolicy(policy, catalog, savedPolicy) : false;
	const confidentiality = report?.confidentialityLevel ?? "unknown";

	const header = (
		<ModuleHeader
			kicker={t("navigation:groups.toolbox")}
			title={t("offlineMode:title")}
			description={t("offlineMode:description")}
			icon={WifiOff}
			tone="green"
			actions={
				projectPath ? (
					<>
						<Chip tone={CONFIDENTIALITY_TONES[confidentiality] ?? "muted"}>
							{t(`offlineMode:confidentiality.${confidentiality}`, confidentiality)}
						</Chip>
						<CharterButton
							variant="ghost"
							icon={RefreshCw}
							onClick={() => refreshStatus(projectPath)}
							disabled={loading || scanning}
						>
							{t("offlineMode:refresh")}
						</CharterButton>
						{policy && (
							<CharterButton
								variant="primary"
								icon={Save}
								busy={saving}
								onClick={() => save(projectPath)}
								disabled={!dirty || saving || scanning || !validPolicy}
							>
								{saving ? t("offlineMode:saving") : t("offlineMode:save")}
							</CharterButton>
						)}
					</>
				) : undefined
			}
		/>
	);

	if (!projectPath) {
		return (
			<ModuleStage data-testid="offline-mode-view">
				{header}
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={WifiOff} tone="green" title={t("offlineMode:title")}>
						{t("offlineMode:noProject")}
					</EmptyStage>
				</div>
			</ModuleStage>
		);
	}

	return (
		<ModuleStage scroll="page" data-testid="offline-mode-view">
			{header}
			<Page className="max-w-none space-y-4">
				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{t(error, { defaultValue: error })}
					</Notice>
				)}

				<Section kicker={t("offlineMode:kickers.runtimes")} title={t("offlineMode:runtimes")}>
					{status ? (
						<>
							<div className="grid gap-2.5 md:grid-cols-3">
								{RUNTIMES.map(([key, label]) => (
									<RuntimePanel key={key} label={label} info={status.runtimes?.[key]} />
								))}
							</div>
							{(status.localModels?.length ?? 0) > 0 && (
								<div className="mt-3">
									<span className="wp-kicker block">{t("offlineMode:localModels")}</span>
									<div className="wp-chips mt-1.5">
										{(status.localModels ?? []).map((m) => (
											<Chip key={m} tone="green" dot={false}>
												<span className="font-mono">{m}</span>
											</Chip>
										))}
									</div>
								</div>
							)}
						</>
					) : (
						<p className="wp-muted text-sm">{t("offlineMode:loading")}</p>
					)}
				</Section>

				{policy && (
					<Section
						kicker={t("offlineMode:kickers.policy")}
						title={t("offlineMode:policy")}
						meta={
							catalog
								? t("offlineMode:catalogMeta", {
										total: Object.values(catalog.providers ?? {}).reduce((s, m) => s + m.length, 0),
										providers: Object.keys(catalog.providers ?? {}).length,
										age: formatAge(catalog.ageSeconds),
									})
								: undefined
						}
						actions={
							<CharterButton
								size="sm"
								variant="ghost"
								icon={ScanIcon}
								busy={scanning}
								onClick={() => scan(projectPath, true)}
								disabled={scanning}
							>
								{scanning ? t("offlineMode:scanning") : t("offlineMode:rescan")}
							</CharterButton>
						}
					>
						<Panel className="space-y-3">
							<label
								htmlFor="offline-airgap"
								className="flex cursor-pointer items-center justify-between gap-3 text-sm"
							>
								<span className="wp-title text-sm">{t("offlineMode:airgapStrict")}</span>
								<Switch id="offline-airgap" checked={policy.airgapStrict} onCheckedChange={setAirgap} />
							</label>
							{/* Le mode strict est la seule bascule du produit qui coupe tous
							    les fournisseurs cloud : elle reste en rouge, jamais en
							    texte gris, pour qu'on ne l'active pas sans la décider. */}
							{policy.airgapStrict ? (
								<Notice tone="red" icon={AlertTriangle} role="alert">
									{t("offlineMode:strictDescription")}
								</Notice>
							) : (
								<p className="wp-muted text-xs">{t("offlineMode:hybridDescription")}</p>
							)}

							<div className="space-y-1.5">
								<label htmlFor="offline-default-provider" className="wp-kicker block">
									{t("offlineMode:defaultProvider")}
								</label>
								<NativeSelect
									id="offline-default-provider"
									value={policy.defaultProvider}
									onChange={(e) => setDefaultProvider(e.target.value)}
									className="h-8 px-2"
								>
									{!LOCAL_PROVIDERS.has(policy.defaultProvider) && (
										<option value={policy.defaultProvider} disabled>
											{policy.defaultProvider} — {t("offlineMode:unavailableProvider")}
										</option>
									)}
									{LOCAL_PROVIDER_IDS.map((provider) => (
										<option key={provider} value={provider}>
											{provider}
										</option>
									))}
								</NativeSelect>
								<p className="wp-muted text-xs">{t("offlineMode:defaultDescription")}</p>
							</div>
							{!validPolicy && (
								<Notice tone="amber" icon={AlertTriangle} role="alert">
									{t("offlineMode:invalidPolicy")}
								</Notice>
							)}
						</Panel>

						<Panel padded={false} className="mt-3 overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="wp-kicker text-left">
										<th className="px-3 py-2">{t("offlineMode:task")}</th>
										<th className="px-3 py-2">{t("offlineMode:providerCol")}</th>
										<th className="px-3 py-2">{t("offlineMode:modelCol")}</th>
										<th className="w-10" />
									</tr>
								</thead>
								<tbody>
									{Object.entries(policy.routing ?? {}).map(([task, entry]) => {
										const models = modelsByProvider(entry.provider);
										const modelMissing = !!entry.model && !models.includes(entry.model);
										const isLocal = LOCAL_PROVIDERS.has(entry.provider);
										return (
											<tr key={task} className="border-t border-[var(--wp-border)]">
												<td className="px-3 py-1.5 font-mono text-xs">
													<span className="flex items-center gap-1.5">
														{task}
														{isLocal && (
															<Home
																className="wp-tone-green wp-ink h-3 w-3"
																aria-label={t("offlineMode:localAria")}
															/>
														)}
													</span>
												</td>
												<td className="px-3 py-1.5">
													<NativeSelect
														value={entry.provider}
														aria-label={t("offlineMode:providerCol")}
														onChange={(e) => {
															const nextProvider = e.target.value;
															const nextModel = modelsByProvider(nextProvider)[0] ?? "";
															setRouting(task, nextProvider, nextModel);
														}}
														className="h-7 w-full px-2 text-sm"
													>
														{!isLocal && (
															<option value={entry.provider} disabled>
																{entry.provider} — {t("offlineMode:unavailableProvider")}
															</option>
														)}
														{LOCAL_PROVIDER_IDS.map((p) => (
															<option key={p} value={p}>
																{p}
															</option>
														))}
													</NativeSelect>
												</td>
												<td className="px-3 py-1.5">
													<NativeSelect
														value={entry.model}
														aria-label={t("offlineMode:modelCol")}
														onChange={(e) => setRouting(task, entry.provider, e.target.value)}
														className={`h-7 w-full px-2 text-sm ${modelMissing ? "border-warning/60" : ""}`}
													>
														{modelMissing && (
															<option value={entry.model} disabled>
																{entry.model} — {t("offlineMode:modelUnavailable")}
															</option>
														)}
														{!entry.model && (
															<option value="" disabled>
																{t("offlineMode:noModelsForProvider")}
															</option>
														)}
														{models.map((m) => (
															<option key={m} value={m}>
																{m}
															</option>
														))}
													</NativeSelect>
												</td>
												<td className="px-2 py-1.5">
													<CharterButton
														size="sm"
														variant="ghost"
														icon={Trash2}
														onClick={() => removeRoutingRow(task)}
														aria-label={t("offlineMode:removeRow")}
														title={t("offlineMode:removeRow")}
													/>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
							<div className="flex items-center gap-2 border-t border-[var(--wp-border)] p-3">
								<Input
									value={newTask}
									onChange={(e) => setNewTask(e.target.value)}
									aria-label={t("offlineMode:addTask")}
									placeholder={t("offlineMode:taskPlaceholder")}
									className="h-8 flex-1 font-mono text-xs"
								/>
								<CharterButton
									size="sm"
									icon={Plus}
									onClick={() => {
										addRoutingRow(newTask.trim());
										setNewTask("");
									}}
									disabled={!newTask.trim()}
								>
									{t("offlineMode:add")}
								</CharterButton>
							</div>
						</Panel>
					</Section>
				)}

				{report && (
					<Section
						kicker={t("offlineMode:kickers.report")}
						title={t("offlineMode:confidentialityReport")}
						meta={t("offlineMode:callsCount", { count: report.total ?? 0 })}
					>
						{report.total === 0 ? (
							<p className="wp-muted text-sm">{t("offlineMode:noCalls")}</p>
						) : (
							<Panel className="space-y-2">
								{Object.entries(report.mix ?? {}).map(([provider, share]) => (
									<div key={provider} className="grid grid-cols-[10rem_1fr_4rem] items-center gap-3 text-xs">
										<span className="truncate font-mono">{provider}</span>
										<Bar value={share * 100} tone={LOCAL_PROVIDERS.has(provider) ? "green" : "amber"} />
										<span className="wp-meta text-right font-mono">{(share * 100).toFixed(1)} %</span>
									</div>
								))}
							</Panel>
						)}
					</Section>
				)}
			</Page>
		</ModuleStage>
	);
}

function RuntimePanel({
	label,
	info,
}: {
	readonly label: string;
	readonly info: OfflineRuntimeInfo | undefined;
}): React.ReactElement {
	const { t } = useTranslation("offlineMode");
	const available = info?.available ?? false;
	return (
		<Panel rail tone={available ? "green" : "muted"}>
			<div className="flex items-center justify-between gap-2">
				<span className="wp-title text-sm">{label}</span>
				<Chip tone={available ? "green" : "muted"}>{available ? t("available") : t("notFound")}</Chip>
			</div>
			{available && info?.models && (
				<p className="wp-meta mt-1">{t("modelsCount", { count: info.models.length })}</p>
			)}
		</Panel>
	);
}

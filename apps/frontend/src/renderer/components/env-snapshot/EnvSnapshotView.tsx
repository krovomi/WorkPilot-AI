import {
	AlertTriangle,
	Camera,
	Container,
	Copy,
	Download,
	FileCode2,
	History,
	Snowflake,
	Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EnvSnapshotFormat } from "../../../preload/api/modules/env-snapshot-api";
import { useEnvSnapshotStore } from "../../stores/env-snapshot-store";
import { formatAppDateTime } from "@/lib/date-format";
import {
	CharterButton,
	Chip,
	Column,
	Columns,
	Composer,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Panel,
	Section,
	Tabs,
} from "../charter";
import { Input } from "../ui/input";

const FORMAT_TABS: ReadonlyArray<{
	id: EnvSnapshotFormat;
	icon: typeof Container;
	key: "docker" | "nix" | "script";
}> = [
	{ id: "dockerfile", icon: Container, key: "docker" },
	{ id: "nix", icon: Snowflake, key: "nix" },
	{ id: "script", icon: Terminal, key: "script" },
];

interface Props {
	readonly projectPath?: string;
}

/** Captured environments of the project, and their replay as code. */
export function EnvSnapshotView({ projectPath }: Props) {
	const { t } = useTranslation(["envSnapshot", "navigation"]);
	const {
		snapshots,
		selectedId,
		capturing,
		exporting,
		replayPayload,
		lastExportedPath,
		error,
		load,
		capture,
		select,
		replay,
		exportSnapshot,
	} = useEnvSnapshotStore();

	const [label, setLabel] = useState("");
	const [format, setFormat] = useState<EnvSnapshotFormat>("dockerfile");

	useEffect(() => {
		if (projectPath) void load(projectPath);
	}, [projectPath, load]);

	const selected = snapshots.find((s) => s.id === selectedId) ?? null;
	const activeFormat = FORMAT_TABS.find((f) => f.id === format) ?? FORMAT_TABS[0];

	const header = (
		<ModuleHeader
			kicker={t("navigation:groups.planning")}
			title={t("envSnapshot:title")}
			description={t("envSnapshot:description")}
			icon={Camera}
			tone="blue"
		/>
	);

	if (!projectPath) {
		return (
			<ModuleStage data-testid="env-snapshot-view">
				{header}
				<div className="relative z-[1] flex flex-1 items-center justify-center p-8">
					<EmptyStage icon={Camera} title={t("envSnapshot:title")} tone="blue">
						{t("envSnapshot:noProject")}
					</EmptyStage>
				</div>
			</ModuleStage>
		);
	}

	const handleCapture = () => {
		void capture(projectPath, { label: label.trim() || undefined });
		setLabel("");
	};

	const tools = selected
		? Object.entries(selected.tools).filter((entry): entry is [string, string] => !!entry[1])
		: [];

	return (
		<ModuleStage data-testid="env-snapshot-view">
			{header}
			{error && (
				<div className="relative z-[1] px-5 pb-2">
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				</div>
			)}
			<Columns template="minmax(16rem, 1fr) minmax(0, 2.5fr)">
				<Column
					kicker={t("envSnapshot:kickers.history")}
					title={t("envSnapshot:history")}
					meta={snapshots.length}
					tone="blue"
				>
					{snapshots.length === 0 ? (
						<EmptyStage icon={History} title={t("envSnapshot:emptyTitle")} tone="blue">
							{t("envSnapshot:empty")}
						</EmptyStage>
					) : (
						<div className="grid gap-2">
							{snapshots.map((s) => (
								<button
									key={s.id}
									type="button"
									onClick={() => select(s.id)}
									className="wp-card wp-card-pad wp-rail wp-step wp-tone-blue text-left"
									data-active={selectedId === s.id ? "true" : undefined}
								>
									<div className="wp-title text-sm">{s.label || s.id}</div>
									<div className="wp-meta mt-0.5">{formatAppDateTime(s.createdAt)}</div>
									<div className="wp-muted mt-0.5 truncate font-mono text-xs">
										{s.git.branch} @ {s.git.commit.slice(0, 8) || "—"}
									</div>
								</button>
							))}
						</div>
					)}
				</Column>

				<Column
					kicker={t("envSnapshot:kickers.detail")}
					title={selected ? selected.label || selected.id : t("envSnapshot:selectTitle")}
					meta={selected ? formatAppDateTime(selected.createdAt) : undefined}
				>
					{selected ? (
						<div className="space-y-4">
							<div className="wp-chips">
								<Chip tone="muted" dot={false}>
									{selected.os.system} {selected.os.release}
								</Chip>
								<Chip tone="muted" dot={false}>
									<span className="font-mono">{selected.git.commit.slice(0, 12) || "—"}</span>
								</Chip>
								{selected.git.dirty.length > 0 && (
									<Chip tone="amber">
										{t("envSnapshot:dirtyCount", { count: selected.git.dirty.length })}
									</Chip>
								)}
							</div>

							<Section kicker={t("envSnapshot:kickers.tools")} title={t("envSnapshot:toolsTitle")}>
								{tools.length === 0 ? (
									<p className="wp-muted text-sm">{t("envSnapshot:noTools")}</p>
								) : (
									<div className="wp-chips">
										{tools.map(([name, version]) => (
											<Chip key={name} tone="blue" dot={false} title={version}>
												<span className="font-semibold">{name}</span>
												<span className="max-w-[12rem] truncate font-mono">{version}</span>
											</Chip>
										))}
									</div>
								)}
							</Section>

							<Section kicker={t("envSnapshot:kickers.lockfiles")} title={t("envSnapshot:lockfiles")}>
								{selected.lockfiles.length === 0 ? (
									<p className="wp-muted text-sm">{t("envSnapshot:noLockfiles")}</p>
								) : (
									<Panel className="grid gap-1 font-mono text-xs">
										{selected.lockfiles.map((l) => (
											<div key={l.name} className="flex justify-between gap-2">
												<span>{l.name}</span>
												<span className="wp-muted truncate">{l.sha256?.slice(0, 12) ?? "—"}</span>
											</div>
										))}
									</Panel>
								)}
							</Section>

							<Section
								kicker={t("envSnapshot:kickers.replay")}
								title={t("envSnapshot:replayTargetLabel")}
								description={t(`envSnapshot:formats.${activeFormat.key}.description`)}
								actions={
									<>
										<CharterButton
											size="sm"
											icon={FileCode2}
											onClick={() => void replay(projectPath, selected.id, format)}
										>
											{t("envSnapshot:preview")}
										</CharterButton>
										<CharterButton
											size="sm"
											icon={Download}
											busy={exporting}
											disabled={exporting}
											onClick={() => void exportSnapshot(projectPath, selected.id, format)}
										>
											{exporting ? t("envSnapshot:exporting") : t("envSnapshot:export")}
										</CharterButton>
									</>
								}
							>
								<Tabs
									tabs={FORMAT_TABS.map((f) => ({
										id: f.id,
										icon: f.icon,
										label: t(`envSnapshot:formats.${f.key}.label`),
									}))}
									value={format}
									onChange={setFormat}
									label={t("envSnapshot:replayTargetLabel")}
								/>
								{lastExportedPath && (
									<Notice tone="green" icon={Download} className="mt-3">
										{t("envSnapshot:exportedTo")} <span className="font-mono">{lastExportedPath}</span>
									</Notice>
								)}
								{replayPayload?.snapId === selected.id && (
									<div className="mt-3">
										<div className="mb-1 flex items-center justify-between">
											<span className="wp-kicker">{replayPayload.format}</span>
											<CharterButton
												size="sm"
												variant="ghost"
												icon={Copy}
												onClick={() => void navigator.clipboard.writeText(replayPayload.payload)}
											>
												{t("envSnapshot:copy")}
											</CharterButton>
										</div>
										<pre className="wp-code max-h-[22rem] overflow-auto whitespace-pre-wrap">
											{replayPayload.payload}
										</pre>
									</div>
								)}
							</Section>
						</div>
					) : (
						<EmptyStage icon={Camera} title={t("envSnapshot:selectTitle")} tone="blue">
							{t("envSnapshot:selectPrompt")}
						</EmptyStage>
					)}
				</Column>
			</Columns>

			<Composer
				prompt={
					<Input
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder={t("envSnapshot:labelPlaceholder")}
						aria-label={t("envSnapshot:labelField")}
						className="h-8 min-w-0 flex-1 text-sm"
					/>
				}
				actions={
					<CharterButton
						variant="primary"
						icon={Camera}
						busy={capturing}
						disabled={capturing}
						onClick={handleCapture}
					>
						{capturing ? t("envSnapshot:capturing") : t("envSnapshot:capture")}
					</CharterButton>
				}
				hint={t("envSnapshot:captureHint")}
			/>
		</ModuleStage>
	);
}

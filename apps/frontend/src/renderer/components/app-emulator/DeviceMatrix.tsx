import { Camera, CheckCircle2, Download, Loader2, Square } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { DEVICE_ORIENTATIONS, DEVICE_PRESETS, orientationOf } from "../../../shared/constants/device-presets";
import { CPU_PROFILES, NETWORK_PROFILES, findCpuProfile } from "../../../shared/constants/emulation-throttling";
import type {
	CpuProfileId,
	DeviceCapture,
	DeviceCategory,
	DeviceGridExportFormat,
	DeviceOrientation,
	DevicePreset,
	NetworkProfileId,
	ResponsiveReport,
} from "../../../shared/types/device-matrix";
import { useDeviceLibraryStore } from "../../stores/device-library-store";
import { type DeviceCaptureEntry, useDeviceMatrixStore } from "../../stores/device-matrix-store";
import { Button } from "../ui/button";
import { BreakpointScanPanel } from "./BreakpointScanPanel";
import { CustomDevices } from "./CustomDevices";
import { LiveMatrix } from "./LiveMatrix";
import { ISSUE_KEYS, MarkedCapture } from "./MarkedCapture";
import { SessionChoice } from "./SessionChoice";

const CATEGORIES: readonly DeviceCategory[] = ["phone", "tablet", "desktop", "tv"];

const EXPORT_FORMATS: readonly DeviceGridExportFormat[] = ["png", "pdf"];
const EXPORT_KEYS: Record<DeviceGridExportFormat, string> = { png: "matrix.exportPng", pdf: "matrix.exportPdf" };

/** Exemples affichés par sorte de bug : le rapport en garde plus. */
const SHOWN_SAMPLES = 3;

/**
 * Le chemin que la matrice rend : celui de la page affichée quand elle est
 * sur le serveur de l'émulateur, sinon la racine (`sameServer: false`). Le
 * main ne prend de toute façon que l'origine de son serveur.
 */
export function matrixPath(serverUrl: string, currentUrl: string): { path: string; sameServer: boolean } {
	try {
		const server = new URL(serverUrl);
		const shown = new URL(currentUrl);
		if (shown.origin === server.origin) {
			return { path: `${shown.pathname}${shown.search}${shown.hash}`, sameServer: true };
		}
	} catch {
		// une adresse illisible : la racine du serveur
	}
	return { path: "/", sameServer: false };
}

interface DeviceMatrixProps {
	/** La racine du serveur lancé par l'émulateur. */
	serverUrl: string;
	/** La page que l'aperçu affiche. */
	currentUrl: string;
	/** Garder une capture pour la revue visuelle ; sans lui, pas de bouton. */
	onCapture?: (image: string, url: string) => void;
	/** La matrice a été ouverte d'office pour la revue d'une tâche : elle le dit. */
	auto?: boolean;
	/** Change quand l'aperçu est rechargé : les vues vivantes se rechargent avec lui. */
	refreshKey?: number;
}

/** Plusieurs appareils, capturés par le main et lus pour les bugs responsive, côte à côte. */
export function DeviceMatrix({ serverUrl, currentUrl, onCapture, auto = false, refreshKey = 0 }: DeviceMatrixProps) {
	const { t } = useTranslation("appEmulator");
	const [live, setLive] = useState(false);
	const {
		selected,
		entries,
		running,
		stopRequested,
		network,
		cpu,
		orientation,
		showMarkers,
		exporting,
		exportStatus,
		scanning,
	} = useDeviceMatrixStore(
		useShallow((state) => ({
			selected: state.selected,
			entries: state.entries,
			running: state.running,
			stopRequested: state.stopRequested,
			network: state.network,
			cpu: state.cpu,
			orientation: state.orientation,
			showMarkers: state.showMarkers,
			exporting: state.exporting,
			exportStatus: state.exportStatus,
			scanning: state.scan?.status === "running",
		})),
	);
	const toggleDevice = useDeviceMatrixStore((state) => state.toggleDevice);
	const setSelection = useDeviceMatrixStore((state) => state.setSelection);
	const captureSelected = useDeviceMatrixStore((state) => state.captureSelected);
	const stop = useDeviceMatrixStore((state) => state.stop);
	const clear = useDeviceMatrixStore((state) => state.clear);
	const setNetwork = useDeviceMatrixStore((state) => state.setNetwork);
	const setCpu = useDeviceMatrixStore((state) => state.setCpu);
	const setOrientation = useDeviceMatrixStore((state) => state.setOrientation);
	const setShowMarkers = useDeviceMatrixStore((state) => state.setShowMarkers);
	const exportGrid = useDeviceMatrixStore((state) => state.exportGrid);
	const customDevices = useDeviceLibraryStore((state) => state.customDevices);
	const loadLibrary = useDeviceLibraryStore((state) => state.load);
	useEffect(() => {
		void loadLibrary();
	}, [loadLibrary]);
	const devices: readonly DevicePreset[] = [...DEVICE_PRESETS, ...customDevices];
	const busy = running || scanning;
	const { path, sameServer } = matrixPath(serverUrl, currentUrl);
	const tiles = devices.filter((device) => entries[device.id]);
	const exportable = tiles.some((device) => entries[device.id].status === "done");

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="shrink-0 space-y-2 border-b border-border p-2">
				{auto && (
					<p role="status" className="text-xs font-medium">
						{t("matrix.auto")}
					</p>
				)}
				<p className="text-xs text-muted-foreground">
					{sameServer ? t("matrix.intro", { path }) : t("matrix.introRoot")}
				</p>
				<div className="flex flex-wrap gap-4">
					{CATEGORIES.map((category) => (
						<fieldset key={category} className="space-y-1" disabled={busy}>
							<legend className="text-xs font-medium">{t(`matrix.category.${category}`)}</legend>
							{DEVICE_PRESETS.filter((device) => device.category === category).map((device) => (
								<label key={device.id} className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={selected.includes(device.id)}
										onChange={() => toggleDevice(device.id)}
									/>
									<span>{t(`devices.${device.id}`)}</span>
									<span className="text-xs text-muted-foreground">{dimensions(t, device)}</span>
								</label>
							))}
						</fieldset>
					))}
					<CustomDevices
						selected={selected}
						disabled={busy}
						onToggle={toggleDevice}
						dimensions={(device) => dimensions(t, device)}
					/>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<Choice
						label={t("matrix.orientation.label")}
						value={orientation}
						disabled={running}
						onChange={(value) => setOrientation(value as DeviceOrientation)}
					>
						{DEVICE_ORIENTATIONS.map((id) => (
							<option key={id} value={id}>
								{t(`matrix.orientation.${id}`)}
							</option>
						))}
					</Choice>
					<Choice
						label={t("matrix.throttling.network")}
						value={network}
						disabled={running}
						onChange={(value) => setNetwork(value as NetworkProfileId)}
					>
						{NETWORK_PROFILES.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{t(`matrix.network.${profile.id}`)}
							</option>
						))}
					</Choice>
					<Choice
						label={t("matrix.throttling.cpu")}
						value={cpu}
						disabled={running}
						onChange={(value) => setCpu(value as CpuProfileId)}
					>
						{CPU_PROFILES.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{t(`matrix.cpu.${profile.id}`)}
							</option>
						))}
					</Choice>
					<p className="max-w-xs text-xs text-muted-foreground">{t("matrix.throttling.hint")}</p>
				</div>
				<div className="flex flex-wrap items-start gap-4 text-sm">
					<SessionChoice disabled={busy} />
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={showMarkers}
							onChange={(event) => setShowMarkers(event.target.checked)}
						/>
						{t("matrix.markers")}
					</label>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{running ? (
						<Button size="sm" variant="outline" disabled={stopRequested} onClick={stop}>
							<Square className="mr-1 h-3.5 w-3.5" />
							{t("matrix.stop")}
						</Button>
					) : (
						<Button size="sm" disabled={selected.length === 0 || scanning} onClick={() => void captureSelected(path)}>
							<Camera className="mr-1 h-3.5 w-3.5" />
							{t("matrix.capture", { count: selected.length })}
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						disabled={running}
						onClick={() => setSelection(devices.map((device) => device.id))}
					>
						{t("matrix.selectAll")}
					</Button>
					<Button size="sm" variant="ghost" disabled={running} onClick={() => setSelection([])}>
						{t("matrix.selectNone")}
					</Button>
					<Button size="sm" variant="ghost" disabled={running || tiles.length === 0} onClick={clear}>
						{t("matrix.clear")}
					</Button>
					{EXPORT_FORMATS.map((format) => (
						<Button
							key={format}
							size="sm"
							variant="outline"
							disabled={busy || exporting || !exportable}
							onClick={() => void exportGrid(format)}
						>
							{exporting ? (
								<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
							) : (
								<Download className="mr-1 h-3.5 w-3.5" />
							)}
							{exporting ? t("matrix.exporting") : t(EXPORT_KEYS[format])}
						</Button>
					))}
				</div>
				{exportStatus?.status === "saved" && (
					<p role="status" className="text-xs text-success">
						{t("matrix.exported", { name: exportStatus.fileName })}
					</p>
				)}
				{exportStatus?.status === "failed" && (
					<p role="alert" className="text-xs text-destructive">
						{t(`matrix.exportErrors.${exportStatus.error}`)}
					</p>
				)}
				<BreakpointScanPanel
					path={path}
					devices={devices}
					disabled={running || exporting}
					deviceName={(device) => deviceName(t, device)}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				<div className="mb-3 flex gap-1">
					{[false, true].map((mode) => (
						<Button
							key={String(mode)}
							size="sm"
							variant={live === mode ? "default" : "outline"}
							aria-pressed={live === mode}
							onClick={() => setLive(mode)}
						>
							{t(mode ? "matrix.mode.live" : "matrix.mode.captures")}
						</Button>
					))}
				</div>
				{live ? (
					<LiveMatrix
						serverUrl={serverUrl}
						path={path}
						devices={devices.filter((device) => selected.includes(device.id))}
						orientation={orientation}
						refreshKey={refreshKey}
						deviceName={(device) => deviceName(t, device)}
					/>
				) : tiles.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("matrix.empty")}</p>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] items-start gap-3">
						{tiles.map((device) => (
							<DeviceTile
								key={device.id}
								device={device}
								entry={entries[device.id]}
								markers={showMarkers}
								onCapture={onCapture}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** Une liste déroulante sous son étiquette. */
function Choice({
	label,
	value,
	disabled,
	onChange,
	children,
}: {
	label: string;
	value: string;
	disabled: boolean;
	onChange: (value: string) => void;
	children: ReactNode;
}) {
	return (
		<label className="flex flex-col gap-1 text-xs font-medium">
			{label}
			<select
				className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
			>
				{children}
			</select>
		</label>
	);
}

/** Le nom d'un appareil : celui que la personne a donné, ou celui du catalogue. */
export function deviceName(t: Translate, device: DevicePreset): string {
	return device.name ?? t(`devices.${device.id}`);
}

function dimensions(t: Translate, device: Pick<DevicePreset, "width" | "height" | "deviceScaleFactor">): string {
	return t("matrix.dimensions", {
		width: device.width,
		height: device.height,
		dpr: device.deviceScaleFactor,
	});
}

/**
 * Le sens si l'appareil a été tourné, la session prêtée, le bridage s'il y en
 * a eu un, puis le temps de chargement.
 */
function conditions(
	t: Translate,
	language: string,
	device: DevicePreset,
	capture: DeviceCapture,
	personaName: string | undefined,
): string {
	const parts: string[] = [];
	// Rendu dans l'autre sens que celui de l'appareil : il a été tourné.
	if (orientationOf(device) !== capture.orientation) parts.push(t(`matrix.orientation.${capture.orientation}`));
	if (capture.previewSession) parts.push(t("matrix.withPreviewSession"));
	if (capture.persona) parts.push(t("matrix.withPersona", { name: personaName ?? capture.persona }));
	if (capture.network !== "none") parts.push(t(`matrix.network.${capture.network}`));
	const rate = findCpuProfile(capture.cpu)?.rate ?? 1;
	if (rate > 1) parts.push(t("matrix.cpuSlowdown", { rate }));
	const seconds = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
		capture.loadMs / 1000,
	);
	parts.push(t("matrix.loadTime", { seconds }));
	return parts.join(" · ");
}

function DeviceTile({
	device,
	entry,
	markers,
	onCapture,
}: {
	device: DevicePreset;
	entry: DeviceCaptureEntry;
	markers: boolean;
	onCapture?: (image: string, url: string) => void;
}) {
	const { t, i18n } = useTranslation("appEmulator");
	const name = deviceName(t, device);
	const personas = useDeviceLibraryStore((state) => state.personas);
	const personaName =
		entry.status === "done" ? personas.find((persona) => persona.id === entry.capture.persona)?.name : undefined;
	// Une capture faite donne la fenêtre rendue (tournée ou non).
	const shown = entry.status === "done" ? { ...device, width: entry.capture.width, height: entry.capture.height } : device;
	return (
		<figure className="space-y-2 rounded-md border border-border bg-card p-2" data-device={device.id}>
			<figcaption className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">{name}</span>
				<span className="text-xs text-muted-foreground">{dimensions(t, shown)}</span>
			</figcaption>
			{entry.status === "pending" && <p className="text-xs text-muted-foreground">{t("matrix.pending")}</p>}
			{entry.status === "capturing" && (
				<p role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
					<Loader2 className="h-3 w-3 animate-spin" />
					{t("matrix.capturing")}
				</p>
			)}
			{entry.status === "failed" && (
				<p role="alert" className="text-xs text-destructive">
					{t(`matrix.errors.${entry.error}`)}
				</p>
			)}
			{entry.status === "done" && (
				<>
					<p className="text-xs text-muted-foreground">{conditions(t, i18n.language, device, entry.capture, personaName)}</p>
					<MarkedCapture capture={entry.capture} name={name} markers={markers} />
					<ReportSummary report={entry.capture.report} />
					{onCapture && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => onCapture(entry.capture.image, entry.capture.url)}
						>
							{t("matrix.keep")}
						</Button>
					)}
				</>
			)}
		</figure>
	);
}

function ReportSummary({ report }: { report: ResponsiveReport | null }) {
	const { t } = useTranslation("appEmulator");
	if (!report) return <p className="text-xs text-muted-foreground">{t("matrix.report.unavailable")}</p>;
	const overflow = report.scrollWidth - report.viewportWidth;
	const clean = overflow <= 1 && report.issues.length === 0;
	return (
		<div className="space-y-1 text-xs">
			{clean && (
				<p className="flex items-center gap-1 text-success">
					<CheckCircle2 className="h-3 w-3" />
					{t("matrix.report.clean")}
				</p>
			)}
			{overflow > 1 && <p className="text-warning">{t("matrix.report.pageOverflow", { px: overflow })}</p>}
			{report.issues.length > 0 && (
				<ul className="space-y-1">
					{report.issues.map((issue) => (
						<li key={issue.kind}>
							<span className="text-warning">{t(ISSUE_KEYS[issue.kind], { count: issue.count })}</span>
							<span className="ml-1 break-all text-muted-foreground">
								{issue.samples.slice(0, SHOWN_SAMPLES).map((sample) => (
									<code key={`${sample.selector}-${sample.x}-${sample.y}`} className="mr-1">
										{sample.selector}
									</code>
								))}
							</span>
						</li>
					))}
				</ul>
			)}
			{report.truncated && (
				<p className="text-muted-foreground">{t("matrix.report.truncated", { count: report.scanned })}</p>
			)}
		</div>
	);
}

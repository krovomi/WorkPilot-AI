import { Camera, CheckCircle2, Download, Loader2, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { DEVICE_PRESETS } from "../../../shared/constants/device-presets";
import { CPU_PROFILES, NETWORK_PROFILES, findCpuProfile } from "../../../shared/constants/emulation-throttling";
import type {
	CpuProfileId,
	DeviceCapture,
	DeviceCategory,
	DevicePreset,
	NetworkProfileId,
	ResponsiveIssueKind,
	ResponsiveReport,
} from "../../../shared/types/device-matrix";
import { type DeviceCaptureEntry, useDeviceMatrixStore } from "../../stores/device-matrix-store";
import { Button } from "../ui/button";

const CATEGORIES: readonly DeviceCategory[] = ["phone", "tablet", "desktop", "tv"];

const ISSUE_KEYS: Record<ResponsiveIssueKind, string> = {
	"horizontal-overflow": "matrix.issues.horizontalOverflow",
	"overflowing-media": "matrix.issues.overflowingMedia",
	"small-touch-target": "matrix.issues.smallTouchTarget",
	"small-text": "matrix.issues.smallText",
	"overlapping-elements": "matrix.issues.overlappingElements",
	"truncated-text": "matrix.issues.truncatedText",
};

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
}

/** Plusieurs appareils, capturés par le main et lus pour les bugs responsive, côte à côte. */
export function DeviceMatrix({ serverUrl, currentUrl, onCapture }: DeviceMatrixProps) {
	const { t } = useTranslation("appEmulator");
	const { selected, entries, running, stopRequested, network, cpu, exporting, exportStatus } = useDeviceMatrixStore(
		useShallow((state) => ({
			selected: state.selected,
			entries: state.entries,
			running: state.running,
			stopRequested: state.stopRequested,
			network: state.network,
			cpu: state.cpu,
			exporting: state.exporting,
			exportStatus: state.exportStatus,
		})),
	);
	const toggleDevice = useDeviceMatrixStore((state) => state.toggleDevice);
	const setSelection = useDeviceMatrixStore((state) => state.setSelection);
	const captureSelected = useDeviceMatrixStore((state) => state.captureSelected);
	const stop = useDeviceMatrixStore((state) => state.stop);
	const clear = useDeviceMatrixStore((state) => state.clear);
	const setNetwork = useDeviceMatrixStore((state) => state.setNetwork);
	const setCpu = useDeviceMatrixStore((state) => state.setCpu);
	const exportGrid = useDeviceMatrixStore((state) => state.exportGrid);
	const { path, sameServer } = matrixPath(serverUrl, currentUrl);
	const tiles = DEVICE_PRESETS.filter((device) => entries[device.id]);
	const exportable = tiles.some((device) => entries[device.id].status === "done");

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="shrink-0 space-y-2 border-b border-border p-2">
				<p className="text-xs text-muted-foreground">
					{sameServer ? t("matrix.intro", { path }) : t("matrix.introRoot")}
				</p>
				<div className="flex flex-wrap gap-4">
					{CATEGORIES.map((category) => (
						<fieldset key={category} className="space-y-1" disabled={running}>
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
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.throttling.network")}
						<select
							className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
							value={network}
							disabled={running}
							onChange={(event) => setNetwork(event.target.value as NetworkProfileId)}
						>
							{NETWORK_PROFILES.map((profile) => (
								<option key={profile.id} value={profile.id}>
									{t(`matrix.network.${profile.id}`)}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						{t("matrix.throttling.cpu")}
						<select
							className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
							value={cpu}
							disabled={running}
							onChange={(event) => setCpu(event.target.value as CpuProfileId)}
						>
							{CPU_PROFILES.map((profile) => (
								<option key={profile.id} value={profile.id}>
									{t(`matrix.cpu.${profile.id}`)}
								</option>
							))}
						</select>
					</label>
					<p className="max-w-xs text-xs text-muted-foreground">{t("matrix.throttling.hint")}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{running ? (
						<Button size="sm" variant="outline" disabled={stopRequested} onClick={stop}>
							<Square className="mr-1 h-3.5 w-3.5" />
							{t("matrix.stop")}
						</Button>
					) : (
						<Button size="sm" disabled={selected.length === 0} onClick={() => void captureSelected(path)}>
							<Camera className="mr-1 h-3.5 w-3.5" />
							{t("matrix.capture", { count: selected.length })}
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						disabled={running}
						onClick={() => setSelection(DEVICE_PRESETS.map((device) => device.id))}
					>
						{t("matrix.selectAll")}
					</Button>
					<Button size="sm" variant="ghost" disabled={running} onClick={() => setSelection([])}>
						{t("matrix.selectNone")}
					</Button>
					<Button size="sm" variant="ghost" disabled={running || tiles.length === 0} onClick={clear}>
						{t("matrix.clear")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={running || exporting || !exportable}
						onClick={() => void exportGrid()}
					>
						{exporting ? (
							<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
						) : (
							<Download className="mr-1 h-3.5 w-3.5" />
						)}
						{exporting ? t("matrix.exporting") : t("matrix.export")}
					</Button>
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
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{tiles.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("matrix.empty")}</p>
				) : (
					<div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] items-start gap-3">
						{tiles.map((device) => (
							<DeviceTile
								key={device.id}
								device={device}
								entry={entries[device.id]}
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

function dimensions(t: Translate, device: DevicePreset): string {
	return t("matrix.dimensions", {
		width: device.width,
		height: device.height,
		dpr: device.deviceScaleFactor,
	});
}

/** Le bridage du rendu, s'il y en a eu un, puis le temps de chargement. */
function conditions(t: Translate, language: string, capture: DeviceCapture): string {
	const parts: string[] = [];
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
	onCapture,
}: {
	device: DevicePreset;
	entry: DeviceCaptureEntry;
	onCapture?: (image: string, url: string) => void;
}) {
	const { t, i18n } = useTranslation("appEmulator");
	const name = t(`devices.${device.id}`);
	return (
		<figure className="space-y-2 rounded-md border border-border bg-card p-2" data-device={device.id}>
			<figcaption className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">{name}</span>
				<span className="text-xs text-muted-foreground">{dimensions(t, device)}</span>
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
					<p className="text-xs text-muted-foreground">{conditions(t, i18n.language, entry.capture)}</p>
					<img
						src={entry.capture.image}
						alt={t("matrix.imageAlt", { device: name })}
						className="block h-auto w-full border border-border bg-white"
					/>
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

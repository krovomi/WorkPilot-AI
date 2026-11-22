import { Loader2, Ruler } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BreakpointScan } from "../../../shared/types/device-library";
import type { DevicePreset } from "../../../shared/types/device-matrix";
import { useDeviceMatrixStore } from "../../stores/device-matrix-store";
import { Button } from "../ui/button";
import { ISSUE_KEYS } from "./MarkedCapture";

/** L'appareil proposé d'abord : un navigateur de bureau qu'on redimensionne. */
export const DEFAULT_SCAN_DEVICE_ID = "desktop-1080p";

interface BreakpointScanPanelProps {
	/** Le chemin que la matrice rend. */
	path: string;
	devices: readonly DevicePreset[];
	disabled: boolean;
	/** Le nom affiché d'un appareil (du catalogue ou personnalisé). */
	deviceName: (device: DevicePreset) => string;
}

/** Les largeurs à un pixel d'un point de rupture : là où la mise en page bascule. */
function nearBreakpoint(width: number, breakpoints: readonly number[]): boolean {
	return breakpoints.some((breakpoint) => Math.abs(breakpoint - width) <= 1);
}

/**
 * La relecture d'une page à plusieurs largeurs : les points de rupture que la
 * page déclare, et ce que la lecture trouve juste avant et juste après chacun.
 */
export function BreakpointScanPanel({ path, devices, disabled, deviceName }: BreakpointScanPanelProps) {
	const { t } = useTranslation("appEmulator");
	const scan = useDeviceMatrixStore((state) => state.scan);
	const scanBreakpoints = useDeviceMatrixStore((state) => state.scanBreakpoints);
	const [deviceId, setDeviceId] = useState(DEFAULT_SCAN_DEVICE_ID);
	const running = scan?.status === "running";

	return (
		<section className="space-y-2 border-t border-border pt-2" aria-label={t("matrix.scan.title")}>
			<h3 className="text-xs font-medium">{t("matrix.scan.title")}</h3>
			<p className="text-xs text-muted-foreground">{t("matrix.scan.intro")}</p>
			<div className="flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1 text-xs font-medium">
					{t("matrix.scan.device")}
					<select
						className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
						value={deviceId}
						disabled={disabled || running}
						onChange={(event) => setDeviceId(event.target.value)}
					>
						{devices.map((device) => (
							<option key={device.id} value={device.id}>
								{deviceName(device)}
							</option>
						))}
					</select>
				</label>
				<Button
					size="sm"
					variant="outline"
					disabled={disabled || running}
					onClick={() => void scanBreakpoints(deviceId, path)}
				>
					{running ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Ruler className="mr-1 h-3.5 w-3.5" />}
					{running ? t("matrix.scan.running") : t("matrix.scan.run")}
				</Button>
			</div>
			{scan?.status === "failed" && (
				<p role="alert" className="text-xs text-destructive">
					{t(`matrix.errors.${scan.error}`)}
				</p>
			)}
			{scan?.status === "done" && <ScanResult scan={scan.scan} />}
		</section>
	);
}

function ScanResult({ scan }: { scan: BreakpointScan }) {
	const { t } = useTranslation("appEmulator");
	return (
		<div className="space-y-1 text-xs">
			<p className="text-muted-foreground">
				{scan.breakpoints.length > 0
					? t("matrix.scan.breakpoints", {
							list: scan.breakpoints.map((width) => t("matrix.scan.widthPx", { width })).join(", "),
						})
					: t("matrix.scan.none")}
			</p>
			<table className="w-full border-collapse text-left">
				<thead>
					<tr className="border-b border-border">
						<th className="py-1 pr-2 font-medium">{t("matrix.scan.width")}</th>
						<th className="py-1 pr-2 font-medium">{t("matrix.scan.overflow")}</th>
						<th className="py-1 font-medium">{t("matrix.scan.issues")}</th>
					</tr>
				</thead>
				<tbody>
					{scan.steps.map((step) => {
						const overflow = step.scrollWidth - step.width;
						const near = nearBreakpoint(step.width, scan.breakpoints);
						return (
							<tr key={step.width} className="border-b border-border/50 align-top" data-width={step.width}>
								<td className="py-1 pr-2">
									<span className={near ? "font-semibold" : undefined}>
										{t("matrix.scan.widthPx", { width: step.width })}
									</span>
									{near && <span className="block text-muted-foreground">{t("matrix.scan.nearBreakpoint")}</span>}
								</td>
								<td className={overflow > 1 ? "py-1 pr-2 text-warning" : "py-1 pr-2"}>
									{overflow > 1 ? t("matrix.scan.overflowPx", { px: overflow }) : t("matrix.scan.clean")}
								</td>
								<td className="py-1">
									{step.issues.length === 0 ? (
										<span className="text-success">{t("matrix.scan.clean")}</span>
									) : (
										<ul>
											{step.issues.map((issue) => (
												<li key={issue.kind} className="text-warning">
													{t(ISSUE_KEYS[issue.kind], { count: issue.count })}
												</li>
											))}
										</ul>
									)}
									{step.truncated && <span className="block text-muted-foreground">{t("matrix.scan.partial")}</span>}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

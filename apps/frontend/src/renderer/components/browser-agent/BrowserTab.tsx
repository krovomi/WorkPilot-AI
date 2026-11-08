import { ArrowLeft, ArrowRight, Camera, ExternalLink, type Globe, MonitorPlay, RotateCw, WifiOff } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserAgentStore } from "@/stores/browser-agent-store";

import { CharterButton, Chip, EmptyStage, Panel, ScanLine } from "../charter";
import { Input } from "../ui/input";
interface BrowserTabProps {
	readonly projectPath: string;
}

export function BrowserTab({ projectPath }: BrowserTabProps) {
	const { t } = useTranslation(["browserAgent"]);
	const {
		currentUrl,
		setCurrentUrl,
		browserStatus,
		browserScreenshot,
		isCapturing,
		captureScreenshot,
	} = useBrowserAgentStore();

	const [screenshotName, setScreenshotName] = useState("");
	const [urlInput, setUrlInput] = useState(currentUrl);
	const [showCaptureBar, setShowCaptureBar] = useState(false);

	const normalizeUrl = useCallback((raw: string) => {
		const trimmed = raw.trim();
		if (!trimmed) return "";
		if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
			return `https://${trimmed}`;
		}
		return trimmed;
	}, []);

	const handleNavigate = useCallback(() => {
		const url = normalizeUrl(urlInput);
		if (!url) return;
		setCurrentUrl(url);
		captureScreenshot(projectPath, "preview", url);
	}, [urlInput, normalizeUrl, setCurrentUrl, captureScreenshot, projectPath]);

	const handleRefresh = useCallback(() => {
		if (!currentUrl) return;
		captureScreenshot(projectPath, "preview", currentUrl);
	}, [currentUrl, captureScreenshot, projectPath]);

	const handleCapture = useCallback(() => {
		if (!currentUrl) return;
		const name = screenshotName.trim() || `capture_${Date.now()}`;
		captureScreenshot(projectPath, name, currentUrl);
		setScreenshotName("");
		setShowCaptureBar(false);
	}, [currentUrl, screenshotName, captureScreenshot, projectPath]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleNavigate();
	};

	const handleOpenExternal = () => {
		if (currentUrl) {
			window.open(currentUrl, "_blank");
		}
	};

	const isNavigating =
		browserStatus === "launching" || browserStatus === "navigating";

	return (
		<Panel padded={false} className="overflow-hidden">
			{/* Browser toolbar */}
			<div className="flex items-center gap-1.5 border-b border-[var(--wp-border)] p-2">
				<ToolbarButton icon={ArrowLeft} disabled title={t("common:buttons.back")} />
				<ToolbarButton icon={ArrowRight} disabled title={t("browserAgent:browser.forward")} />
				<ToolbarButton
					icon={RotateCw}
					onClick={handleRefresh}
					disabled={!currentUrl || isCapturing}
					title={t("browserAgent:browser.refresh")}
					spinning={isNavigating}
				/>
				<div className="wp-prompt flex-1">
					<Input
						type="text"
						value={urlInput}
						onChange={(e) => setUrlInput(e.target.value)}
						onKeyDown={handleKeyDown}
						aria-label={t("browserAgent:browser.urlPlaceholder")}
						placeholder={t("browserAgent:browser.urlPlaceholder")}
						className="h-7 min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-xs shadow-none focus-visible:ring-0"
					/>
				</div>
				<CharterButton
					size="sm"
					onClick={handleNavigate}
					disabled={isCapturing || !urlInput.trim()}
					busy={isNavigating}
				>
					{t("browserAgent:browser.navigate")}
				</CharterButton>
				<ToolbarButton
					icon={Camera}
					onClick={() => setShowCaptureBar(!showCaptureBar)}
					disabled={!currentUrl || isCapturing}
					title={t("browserAgent:browser.captureScreenshot")}
					active={showCaptureBar}
				/>
				<ToolbarButton
					icon={ExternalLink}
					onClick={handleOpenExternal}
					disabled={!currentUrl}
					title={t("browserAgent:browser.openExternal")}
				/>
			</div>

			{/* Screenshot capture bar (collapsible) */}
			{showCaptureBar && (
				<div className="wp-tone-violet flex items-center gap-2 border-b border-[var(--wp-border)] px-3 py-2">
					<Input
						type="text"
						value={screenshotName}
						onChange={(e) => setScreenshotName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleCapture();
						}}
						aria-label={t("browserAgent:browser.screenshotNamePlaceholder")}
						placeholder={t("browserAgent:browser.screenshotNamePlaceholder")}
						className="h-8 flex-1 text-sm"
					/>
					<CharterButton size="sm" icon={Camera} busy={isCapturing} onClick={handleCapture} disabled={isCapturing}>
						{isCapturing ? t("browserAgent:browser.capturing") : t("browserAgent:browser.captureScreenshot")}
					</CharterButton>
				</div>
			)}

			{/* Browser viewport */}
			<div className="relative flex min-h-[400px] items-center justify-center overflow-hidden p-4">
				{isNavigating && browserScreenshot && (
					<div className="absolute inset-x-4 top-4 z-10">
						<ScanLine
							label={
								browserStatus === "launching"
									? t("browserAgent:browser.launching")
									: t("browserAgent:browser.navigating")
							}
						/>
					</div>
				)}
				{browserStatus === "idle" && !browserScreenshot && (
					<EmptyStage icon={MonitorPlay} tone="blue" title={t("browserAgent:browser.idleTitle")}>
						{t("browserAgent:browser.idleDescription")}
					</EmptyStage>
				)}
				{isNavigating && !browserScreenshot && (
					<ScanLine
						label={
							browserStatus === "launching"
								? t("browserAgent:browser.launching")
								: t("browserAgent:browser.navigating")
						}
					/>
				)}
				{browserScreenshot && (
					<img
						src={browserScreenshot}
						alt={t("browserAgent:browser.screenshotAlt")}
						className="max-h-full max-w-full rounded-md object-contain"
					/>
				)}
				{browserStatus === "error" && !browserScreenshot && (
					<EmptyStage icon={WifiOff} tone="red" title={t("browserAgent:errors.screenshotFailed")}>
						{t("browserAgent:browser.errorHint")}
					</EmptyStage>
				)}
			</div>

			{/* Status bar */}
			{currentUrl && (browserStatus === "ready" || browserStatus === "error") && (
				<div className="flex items-center gap-2 border-t border-[var(--wp-border)] px-3 py-1.5">
					{browserStatus === "ready" ? (
						<Chip tone="green">{t("browserAgent:browser.ready")}</Chip>
					) : (
						<Chip tone="red">{t("browserAgent:errors.screenshotFailed")}</Chip>
					)}
					<span className="wp-meta truncate font-mono">{currentUrl}</span>
				</div>
			)}
		</Panel>
	);
}

// ── ToolbarButton ───────────────────────────────────────────

function ToolbarButton({
	icon: Icon,
	onClick,
	disabled = false,
	title,
	spinning = false,
	active = false,
}: {
	readonly icon: typeof Globe;
	readonly onClick?: () => void;
	readonly disabled?: boolean;
	readonly title: string;
	readonly spinning?: boolean;
	readonly active?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={title}
			aria-pressed={active || undefined}
			className={`rounded-md p-1.5 transition-colors ${
				active ? "wp-tone-violet wp-ink bg-[var(--wp-code-bg)]" : "wp-muted hover:text-foreground"
			} disabled:cursor-not-allowed disabled:opacity-30`}
		>
			<Icon className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`} />
		</button>
	);
}

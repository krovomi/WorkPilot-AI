/**
 * ScreenshotCapture - Modal for capturing screenshots
 *
 * Displays available screens and windows in a grid, allowing users to
 * select a source and capture a screenshot.
 *
 * Features:
 * - Grid layout with thumbnail previews
 * - Visual selection with hover effects and checkmarks
 * - High-resolution capture support (handles retina displays)
 * - Loading states and error handling
 * - Refresh button to reload available sources
 */

import {
	AlertCircle,
	Frame,
	Info,
	Loader2,
	Monitor,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenshotSource } from "../../shared/types/screenshot";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

interface ScreenshotCaptureProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onCapture: (imageData: string) => void; // base64 encoded PNG
}

/**
 * Get the appropriate paste keyboard shortcut based on platform
 */
const getPasteShortcut = (): string => {
	// Use modern userAgentData if available, otherwise check userAgent for Mac
	if (navigator.userAgentData?.platform) {
		return navigator.userAgentData.platform.toUpperCase().includes("MAC")
			? "Cmd+V"
			: "Ctrl+V";
	}
	// Fallback: check userAgent instead of deprecated platform
	return /mac|iphone|ipad|ipod/i.test(navigator.userAgent) ? "Cmd+V" : "Ctrl+V";
};

/**
 * Electron names a source `screen:<id>:0` or `window:<id>:0`. Its name is a
 * window title, which may well contain « screen » or « display ».
 */
const isScreenSource = (source: ScreenshotSource): boolean =>
	source.id.startsWith("screen:");

/** The translated failure, then what the main process said, if anything. */
const withDetail = (message: string, detail?: string): string =>
	detail ? `${message}\n${detail}` : message;

export function ScreenshotCapture({
	open,
	onOpenChange,
	onCapture,
}: ScreenshotCaptureProps) {
	const { t } = useTranslation(["tasks", "common"]);
	const [sources, setSources] = useState<ScreenshotSource[]>([]);
	const [selectedSource, setSelectedSource] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isCapturing, setIsCapturing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isDevMode, setIsDevMode] = useState(false);

	/**
	 * Fetch available screenshot sources
	 */
	const fetchSources = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		setIsDevMode(false);
		setSelectedSource(null);
		try {
			const result = await globalThis.electronAPI.getSources();

			// Check if running in dev mode (screenshot capture unavailable)
			if (result.devMode) {
				setIsDevMode(true);
				return;
			}

			if (result.success && result.data) {
				setSources(result.data);
			} else {
				setError(withDetail(t("tasks:screenshot.errors.getSources"), result.error));
			}
		} catch (err) {
			console.error("Failed to fetch screenshot sources:", err);
			setError(
				withDetail(
					t("tasks:screenshot.errors.fetchSources"),
					err instanceof Error ? err.message : undefined,
				),
			);
		} finally {
			setIsLoading(false);
		}
	}, [t]);

	// Fetch sources when dialog opens
	useEffect(() => {
		if (open) {
			fetchSources();
		}
	}, [open, fetchSources]);

	/**
	 * Handle capture button click
	 */
	const handleCapture = async (sourceId: string) => {
		setIsCapturing(true);
		setError(null);
		try {
			const result = await globalThis.electronAPI.capture({ sourceId });
			if (result.success && result.data) {
				onCapture(result.data);
				onOpenChange(false);
				setSelectedSource(null);
			} else {
				setError(withDetail(t("tasks:screenshot.errors.capture"), result.error));
			}
		} catch (err) {
			console.error("Failed to capture screenshot:", err);
			setError(
				withDetail(
					t("tasks:screenshot.errors.captureFailed"),
					err instanceof Error ? err.message : undefined,
				),
			);
		} finally {
			setIsCapturing(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle>{t("tasks:screenshot.title")}</DialogTitle>
					<DialogDescription>
						{t("tasks:screenshot.description")}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto">
					{/* Dev Mode Info State */}
					{isDevMode && (
						<div className="flex items-start gap-3 p-4 bg-warning/10 border border-warning/30 rounded-lg mb-4">
							<Info className="h-5 w-5 text-warning shrink-0 mt-0.5" />
							<div className="flex-1 space-y-2">
								<p className="text-sm font-medium text-warning ">
									{t("tasks:screenshot.devMode.title")}
								</p>
								<p className="text-sm text-warning ">
									{t("tasks:screenshot.devMode.description")}
								</p>
								<p className="text-sm text-warning ">
									{t("tasks:screenshot.devMode.hint", {
										shortcut: getPasteShortcut(),
									})}
								</p>
							</div>
						</div>
					)}

					{/* Error State */}
					{error && !isDevMode && (
						<div className="flex items-center gap-3 p-4 bg-destructive/10 border border-destructive/30 rounded-lg mb-4">
							<AlertCircle className="h-5 w-5 text-destructive shrink-0" />
							<div className="flex-1">
								<p role="alert" className="text-sm text-destructive whitespace-pre-wrap break-words">
									{error}
								</p>
							</div>
							{/* Shown once loading is over: a fetch clears the error first */}
							<Button
								variant="outline"
								size="sm"
								onClick={fetchSources}
								aria-label={t("common:buttons.retry")}
							>
								<RefreshCw className="h-4 w-4" />
							</Button>
						</div>
					)}

					{/* Loading State */}
					{isLoading && sources.length === 0 && !isDevMode && (
						<div className="flex items-center justify-center py-12">
							<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
						</div>
					)}

					{/* Sources Grid */}
					{!isLoading && !isDevMode && sources.length > 0 && (
						<div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-1">
							{sources.map((source) => {
								const isSelected = selectedSource === source.id;
								const isScreen = isScreenSource(source);

								return (
									<button
										key={source.id}
										type="button"
										aria-pressed={isSelected}
										onClick={() => setSelectedSource(source.id)}
										className={`
                      relative group rounded-lg border-2 overflow-hidden
                      transition-all duration-200
                      ${
												isSelected
													? "border-primary ring-2 ring-primary/20"
													: "border-border hover:border-primary/50 hover:ring-2 hover:ring-primary/10"
											}
                    `}
									>
										{/* Thumbnail */}
										<div className="aspect-video bg-muted relative">
											{source.thumbnail ? (
												<img
													src={source.thumbnail}
													alt=""
													className="w-full h-full object-cover"
												/>
											) : (
												<div className="w-full h-full flex items-center justify-center">
													{isScreen ? (
														<Monitor className="h-12 w-12 text-muted-foreground" />
													) : (
														<Frame className="h-12 w-12 text-muted-foreground" />
													)}
												</div>
											)}

											{/* Selection Indicator */}
											{isSelected && (
												<div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
													<div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center">
														{/* biome-ignore lint/a11y/noSvgWithoutTitle: SVG is decorative, intentional */}
														<svg
															className="w-6 h-6 text-primary-foreground"
															fill="none"
															strokeLinecap="round"
															strokeLinejoin="round"
															strokeWidth="2"
															viewBox="0 0 24 24"
															stroke="currentColor"
														>
															<path d="M5 13l4 4L19 7" />
														</svg>
													</div>
												</div>
											)}

											{/* Type Icon */}
											<div className="absolute top-2 left-2">
												<div
													className={`
                          p-1.5 rounded-md
                          ${
														isSelected
															? "bg-primary text-primary-foreground"
															: "bg-background/80 text-foreground backdrop-blur-sm"
													}
                        `}
												>
													{isScreen ? (
														<Monitor className="h-4 w-4" />
													) : (
														<Frame className="h-4 w-4" />
													)}
													<span className="sr-only">
														{isScreen
															? t("tasks:screenshot.kind.screen")
															: t("tasks:screenshot.kind.window")}
													</span>
												</div>
											</div>
										</div>

										{/* Source Name */}
										<div className="p-2 bg-background/95 backdrop-blur-sm">
											<p className="text-sm font-medium truncate text-foreground">
												{source.name}
											</p>
										</div>
									</button>
								);
							})}
						</div>
					)}

					{/* Empty State */}
					{!isLoading && !isDevMode && sources.length === 0 && !error && (
						<div className="flex flex-col items-center justify-center py-12 text-center">
							<Monitor className="h-12 w-12 text-muted-foreground mb-4" />
							<p className="text-sm text-muted-foreground max-w-sm">
								{t("tasks:screenshot.noSources")}
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={fetchSources}
								className="mt-4"
							>
								<RefreshCw className="h-4 w-4 mr-2" />
								{t("common:buttons.retry")}
							</Button>
						</div>
					)}
				</div>

				{/* Footer Actions */}
				<div className="flex items-center justify-between pt-4 border-t">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isCapturing}
					>
						{t("common:buttons.cancel")}
					</Button>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="icon"
							onClick={fetchSources}
							disabled={isLoading || isCapturing || isDevMode}
							title={t("common:buttons.refresh")}
						>
							{isLoading ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="h-4 w-4" />
							)}
						</Button>
						<Button
							onClick={
								selectedSource ? () => void handleCapture(selectedSource) : undefined
							}
							disabled={!selectedSource || isCapturing || isDevMode}
						>
							{isCapturing ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									{t("tasks:screenshot.capturing")}
								</>
							) : (
								t("tasks:screenshot.capture")
							)}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

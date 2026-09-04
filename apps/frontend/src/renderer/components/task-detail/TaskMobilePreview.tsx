import {
	AlertTriangle,
	Camera,
	Loader2,
	Play,
	RefreshCw,
	Smartphone,
	Square,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MobileDevice, MobilePlatform } from "../../../shared/types/mobile";
import type { Project } from "../../../shared/types";
import {
	detectMobileProject,
	launchMobileApp,
	refreshMobileScreenshot,
	setupMobileListeners,
	stopMobileSession,
	useMobileStore,
} from "../../stores/mobile-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

interface TaskMobilePreviewProps {
	taskId: string;
	project?: Project;
	worktreePath?: string;
}

/** Phases during which no new action should be started. */
const BUSY_PHASES = new Set(["detecting", "booting", "building", "installing"]);

/**
 * Previewing a smartphone application from a Kanban card.
 *
 * The App Emulator tab answers "is the dev server up, and what does the page
 * look like". A phone app has neither a server nor a page: it is compiled,
 * installed onto an emulator or a simulator, and the evidence is a frame
 * captured from that device. This panel is that loop — pick a platform, pick a
 * device, run, look.
 *
 * The other half of what it shows is what the machine *cannot* do. An iOS
 * target on Windows or Linux is not a failure to retry: Apple's toolchain does
 * not exist there. Saying so up front is what stops a build being started that
 * can only end in a red log.
 */
export function TaskMobilePreview({
	taskId,
	project,
	worktreePath,
}: TaskMobilePreviewProps) {
	const { t } = useTranslation(["mobile", "common"]);
	const [resolvedWorktreePath, setResolvedWorktreePath] = useState<
		string | null
	>(worktreePath ?? null);

	const plan = useMobileStore((state) => state.plan);
	const phase = useMobileStore((state) => state.phase);
	const platform = useMobileStore((state) => state.platform);
	const device = useMobileStore((state) => state.device);
	const screenshot = useMobileStore((state) => state.screenshot);
	const output = useMobileStore((state) => state.output);
	const status = useMobileStore((state) => state.status);
	const error = useMobileStore((state) => state.error);
	const selectPlatform = useMobileStore((state) => state.selectPlatform);
	const selectDevice = useMobileStore((state) => state.selectDevice);

	useEffect(() => setupMobileListeners(), []);

	useEffect(() => {
		setResolvedWorktreePath(worktreePath ?? null);
	}, [worktreePath]);

	useEffect(() => {
		let cancelled = false;
		globalThis.electronAPI
			.getWorktreeStatus(taskId)
			.then((result) => {
				if (cancelled || !result.success || !result.data?.worktreePath) return;
				setResolvedWorktreePath(result.data.worktreePath);
			})
			.catch(() => {
				// The worktree may have been cleaned up after a PR; the project path
				// remains a valid fallback.
			});
		return () => {
			cancelled = true;
		};
	}, [taskId]);

	const projectDir = resolvedWorktreePath ?? project?.path ?? "";

	// Detect once per directory. Detection is a handful of local file reads and
	// device listings, so re-running it on every render would be wasteful rather
	// than wrong — but the device list going blank mid-interaction is not.
	useEffect(() => {
		if (!projectDir) return;
		void detectMobileProject(projectDir);
	}, [projectDir]);

	const stack = plan?.stack;
	const platforms = stack?.platforms ?? [];
	const readiness = platform ? plan?.platforms?.[platform] : undefined;
	const devices = useMemo(
		() => (plan?.devices ?? []).filter((d) => d.platform === platform),
		[plan?.devices, platform],
	);
	const unavailableReason = platform ? plan?.unavailable?.[platform] : undefined;

	const isBusy = BUSY_PHASES.has(phase);
	const isRunning = phase === "running";
	const canLaunch = Boolean(
		projectDir && platform && device && !isBusy && readiness?.ok !== false,
	);

	const handleLaunch = useCallback(async () => {
		if (!canLaunch) return;
		await launchMobileApp(projectDir);
	}, [canLaunch, projectDir]);

	const handleRefreshDevices = useCallback(async () => {
		if (!projectDir) return;
		await detectMobileProject(projectDir);
	}, [projectDir]);

	if (!projectDir) {
		return (
			<EmptyState
				title={t("mobile:preview.noProjectTitle")}
				description={t("mobile:preview.noProjectDescription")}
			/>
		);
	}

	if (plan && !plan.isMobile) {
		return (
			<EmptyState
				title={t("mobile:preview.notMobileTitle")}
				description={plan.reason ?? t("mobile:preview.notMobileDescription")}
			/>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="shrink-0 border-b border-border p-4 space-y-3">
				<div className="flex flex-wrap items-center gap-2">
					<h3 className="text-lg font-semibold">{t("mobile:preview.title")}</h3>
					<Badge
						variant={isRunning ? "success" : isBusy ? "warning" : "muted"}
						aria-live="polite"
					>
						{t(`mobile:phase.${phase}`)}
					</Badge>
					{stack && <Badge variant="outline">{stack.framework}</Badge>}
					{stack?.packageId && (
						<Badge variant="outline">{stack.packageId}</Badge>
					)}
				</div>

				<p className="text-sm text-muted-foreground">
					{t("mobile:preview.description")}
				</p>

				{platforms.length > 0 && (
					<fieldset className="flex flex-wrap gap-2 border-0 p-0">
						<legend className="sr-only">
							{t("mobile:preview.platformGroup")}
						</legend>
						{platforms.map((entry) => (
							<PlatformButton
								key={entry}
								platform={entry}
								selected={entry === platform}
								buildable={plan?.platforms?.[entry]?.ok !== false}
								label={t(`mobile:platform.${entry}`)}
								onSelect={() => selectPlatform(entry)}
							/>
						))}
					</fieldset>
				)}

				{readiness && !readiness.ok && (
					<BlockerNotice
						blocker={readiness.blocker}
						remedy={readiness.checks.find((check) => check.remedy)?.remedy}
						heading={t("mobile:preview.cannotBuildHere")}
					/>
				)}

				<div className="flex flex-wrap items-end gap-2">
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						{t("mobile:preview.device")}
						<select
							className="min-w-56 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
							value={device?.id ?? ""}
							disabled={devices.length === 0 || isBusy}
							onChange={(event) =>
								selectDevice(
									devices.find((d) => d.id === event.target.value) ?? null,
								)
							}
						>
							{devices.length === 0 && (
								<option value="">{t("mobile:preview.noDevice")}</option>
							)}
							{devices.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{deviceLabel(entry, t("mobile:preview.booted"))}
								</option>
							))}
						</select>
					</label>

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={handleRefreshDevices}
						disabled={isBusy}
					>
						<RefreshCw className="mr-2 h-4 w-4" />
						{t("mobile:actions.refreshDevices")}
					</Button>

					{isRunning ? (
						<Button
							type="button"
							variant="destructive"
							size="sm"
							onClick={() => void stopMobileSession()}
						>
							<Square className="mr-2 h-4 w-4" />
							{t("mobile:actions.stop")}
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							onClick={handleLaunch}
							disabled={!canLaunch}
						>
							{isBusy ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Play className="mr-2 h-4 w-4" />
							)}
							{t("mobile:actions.run")}
						</Button>
					)}

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void refreshMobileScreenshot()}
						disabled={!isRunning}
					>
						<Camera className="mr-2 h-4 w-4" />
						{t("mobile:actions.capture")}
					</Button>
				</div>

				{devices.length === 0 && unavailableReason && (
					<p className="text-xs text-warning">{unavailableReason}</p>
				)}
				{status && <p className="text-xs text-muted-foreground">{status}</p>}
				{error && <p className="text-xs text-destructive">{error}</p>}
			</div>

			<div className="flex flex-1 min-h-0 overflow-hidden">
				<div className="flex flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
					{screenshot ? (
						// A phone-shaped frame, so a portrait screenshot is not stretched
						// across a landscape panel.
						<img
							src={screenshot}
							alt={t("mobile:preview.screenshotAlt")}
							className="max-h-full w-auto rounded-[2rem] border-4 border-foreground/80 shadow-lg"
						/>
					) : (
						<div className="text-center text-sm text-muted-foreground">
							<Smartphone className="mx-auto mb-2 h-10 w-10 opacity-40" />
							{t("mobile:preview.noScreenshot")}
						</div>
					)}
				</div>

				<div className="flex w-2/5 min-w-72 flex-col border-l border-border">
					<div className="flex items-center gap-2 border-b border-border px-4 py-2">
						<Terminal className="h-4 w-4 text-muted-foreground" />
						<span className="text-sm font-medium">
							{t("mobile:preview.logs")}
						</span>
					</div>
					<ScrollArea className="flex-1">
						<pre className="m-3 whitespace-pre-wrap rounded-lg bg-muted/50 p-3 font-mono text-xs text-foreground">
							{output || t("mobile:preview.noLogs")}
						</pre>
					</ScrollArea>
				</div>
			</div>
		</div>
	);
}

function EmptyState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="flex h-full items-center justify-center p-8 text-center">
			<div className="space-y-3">
				<Smartphone className="mx-auto h-10 w-10 text-muted-foreground/40" />
				<h3 className="text-base font-semibold">{title}</h3>
				<p className="max-w-md text-sm text-muted-foreground">{description}</p>
			</div>
		</div>
	);
}

function PlatformButton({
	platform,
	selected,
	buildable,
	label,
	onSelect,
}: {
	platform: MobilePlatform;
	selected: boolean;
	buildable: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<Button
			type="button"
			size="sm"
			variant={selected ? "default" : "outline"}
			aria-pressed={selected}
			onClick={onSelect}
			data-platform={platform}
		>
			{!buildable && <AlertTriangle className="mr-2 h-3.5 w-3.5" />}
			{label}
		</Button>
	);
}

/**
 * The blocker, and the one remedy that goes with it.
 *
 * One remedy, not all of them: a list of five "install X" lines for a machine
 * that is simply not a Mac reads as five problems instead of one fact.
 */
function BlockerNotice({
	blocker,
	remedy,
	heading,
}: {
	blocker: string;
	remedy?: string;
	heading: string;
}) {
	return (
		<div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
			<p className="font-medium text-warning">{heading}</p>
			<p className="mt-1 text-foreground">{blocker}</p>
			{remedy && <p className="mt-1 text-muted-foreground">{remedy}</p>}
		</div>
	);
}

/** Exported for the tests: the label is what tells two AVDs apart in the list. */
export function deviceLabel(device: MobileDevice, bootedLabel: string): string {
	const parts = [device.name];
	if (device.runtime) parts.push(device.runtime);
	if (device.isBooted) parts.push(bootedLabel);
	return parts.join(" · ");
}

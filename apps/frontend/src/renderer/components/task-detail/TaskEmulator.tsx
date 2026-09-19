import {
	ExternalLink,
	Loader2,
	Monitor,
	Play,
	RefreshCw,
	Square,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppEmulatorConfig } from "../../../main/app-emulator-service";
import type { Project } from "../../../shared/types";
import {
	deriveLandingCandidates,
	isBrowsableUrl,
	type LandingGuess,
} from "../../../shared/utils/emulator-landing";
import {
	startAppEmulator,
	stopAppEmulator,
	useAppEmulatorStore,
} from "../../stores/app-emulator-store";
import { ResponsivePreview } from "../app-emulator/ResponsivePreview";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";

interface TaskEmulatorProps {
	taskId: string;
	project?: Project;
	worktreePath?: string;
}

/** L'étiquette qui dit d'où vient la route proposée. */
const LANDING_SOURCE_KEYS: Record<LandingGuess["source"], string> = {
	"route-declaration": "appEmulator:preview.routeSource.declared",
	"file-route": "appEmulator:preview.routeSource.page",
	"launch-profile": "appEmulator:preview.routeSource.launchProfile",
	"api-docs": "appEmulator:preview.routeSource.apiDocs",
};

interface AppEmulatorStatusResult {
	success: boolean;
	data?: {
		running: boolean;
		url?: string;
		config?: AppEmulatorConfig;
	};
}

function isConfigForProject(
	configProjectDir: string | undefined,
	projectPath: string,
) {
	if (!configProjectDir) return true;
	const normalize = (value: string) =>
		value.toLowerCase().replaceAll("/", "\\");
	return normalize(configProjectDir).startsWith(normalize(projectPath));
}

export function TaskEmulator({
	taskId,
	project,
	worktreePath,
}: TaskEmulatorProps) {
	const { t } = useTranslation(["appEmulator", "tasks"]);
	const [browserError, setBrowserError] = useState<string | null>(null);
	/** Ce que l'aperçu montre à cet instant — la cible d'« Ouvrir dans le navigateur ». */
	const [displayedUrl, setDisplayedUrl] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const [changedFiles, setChangedFiles] = useState<
		{ path: string; patch?: string }[]
	>([]);
	const [resolvedWorktreePath, setResolvedWorktreePath] = useState<
		string | null
	>(worktreePath ?? null);
	const phase = useAppEmulatorStore((state) => state.phase);
	const config = useAppEmulatorStore((state) => state.config);
	const url = useAppEmulatorStore((state) => state.url);
	const output = useAppEmulatorStore((state) => state.output);
	const error = useAppEmulatorStore((state) => state.error);
	const status = useAppEmulatorStore((state) => state.status);
	// L'adresse réellement affichée dans l'aperçu — celle qu'« Ouvrir dans le
	// navigateur » doit ouvrir, et celle que l'onglet retrouve en revenant. Elle
	// vit dans le store parce que cet onglet est démonté dès qu'on en regarde un
	// autre ; indexée par tâche, parce que c'est la tâche qui décide de la page.
	const previewUrl = useAppEmulatorStore(
		(state) => state.previewUrls[taskId] ?? null,
	);
	const setPreviewUrl = useAppEmulatorStore((state) => state.setPreviewUrl);
	const setPhase = useAppEmulatorStore((state) => state.setPhase);
	const setConfig = useAppEmulatorStore((state) => state.setConfig);
	const setUrl = useAppEmulatorStore((state) => state.setUrl);
	const setStatus = useAppEmulatorStore((state) => state.setStatus);

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
				// Le worktree peut avoir été nettoyé après PR ; le chemin projet reste le fallback.
			});
		return () => {
			cancelled = true;
		};
	}, [taskId]);

	useEffect(() => {
		let cancelled = false;
		globalThis.electronAPI
			.getAppEmulatorStatus()
			.then((result: AppEmulatorStatusResult) => {
				if (cancelled || !result.success || !result.data) return;
				if (result.data.config) setConfig(result.data.config);
				if (result.data.url) setUrl(result.data.url);
				if (
					result.data.running &&
					(!result.data.config?.isWeb || result.data.url)
				) {
					setPhase("running");
					setStatus(
						result.data.url ? `Running at ${result.data.url}` : "Running",
					);
				}
			})
			.catch(() => {
				// Status sync is best-effort; live events will still update the tab.
			});
		return () => {
			cancelled = true;
		};
	}, [setConfig, setPhase, setStatus, setUrl]);

	// Le diff de la tâche est la seule preuve de ce que cette fonctionnalité a
	// touché. Il est lu une fois par tâche, indépendamment de l'émulateur : la
	// question « quelle route ? » se pose avant d'avoir un serveur, et la réponse
	// ne coûte ni modèle ni réseau.
	useEffect(() => {
		let cancelled = false;
		globalThis.electronAPI
			.getWorktreeDiff(taskId)
			.then((result) => {
				if (cancelled || !result.success || !result.data?.files) return;
				setChangedFiles(
					result.data.files.map((file) => ({
						path: file.path,
						patch: file.patch,
					})),
				);
			})
			.catch(() => {
				// Pas de worktree, pas de diff : l'aperçu ouvre la racine du serveur.
			});
		return () => {
			cancelled = true;
		};
	}, [taskId]);

	const isLoading = phase === "detecting" || phase === "starting";
	const isRunning = phase === "running";
	const canPreview = isRunning && config?.isWeb && Boolean(url);
	const emulatorPath = resolvedWorktreePath ?? project?.path;
	const isOtherProject =
		Boolean(emulatorPath && config) &&
		!isConfigForProject(config?.projectDir, emulatorPath ?? "");

	const formattedOutput = useMemo(
		() => output || t("appEmulator:output.noOutput"),
		[output, t],
	);

	const landingCandidates = useMemo(
		() =>
			deriveLandingCandidates(changedFiles, {
				framework: config?.framework,
				launchPath: config?.launchPath,
			}),
		[changedFiles, config?.framework, config?.launchPath],
	);
	const landing = landingCandidates[0] ?? null;

	// L'aperçu dit où il en est ; on ne le lui demande pas. Stable pour que le
	// rendu du parent ne relance pas l'abonnement de l'enfant.
	const handlePreviewNavigate = useCallback(
		(visited: string, restorable: boolean) => {
			setDisplayedUrl(visited);
			// Seule une page où l'on est allé est reprise au retour sur l'onglet.
			if (restorable) setPreviewUrl(taskId, visited);
			setBrowserError(null);
		},
		[setPreviewUrl, taskId],
	);

	const handleStart = useCallback(async () => {
		if (!emulatorPath || isLoading || isRunning) return;
		await startAppEmulator(emulatorPath);
	}, [emulatorPath, isLoading, isRunning]);

	const handleRestart = useCallback(async () => {
		if (!emulatorPath) return;
		await stopAppEmulator();
		useAppEmulatorStore.getState().reset();
		await startAppEmulator(emulatorPath);
	}, [emulatorPath]);

	const handleStop = useCallback(async () => {
		await stopAppEmulator();
	}, []);

	const handleOpenInBrowser = useCallback(async () => {
		setBrowserError(null);
		// Ce que l'utilisateur regarde, pas la racine du serveur : après une
		// navigation dans l'aperçu, les deux ne sont plus la même page — et sur une
		// Web API la racine est précisément celle qui répond 404.
		//
		// Sauf quand ce n'est pas une adresse : un `<webview>` dont la page n'a pas
		// répondu annonce `chrome-error://chromewebdata/`, que le processus
		// principal refuse à juste titre — le bouton ne faisait alors rien d'autre
		// que rendre une erreur de schéma pour une page que le serveur sert très
		// bien. On retombe sur la racine, qui est toujours ouvrable.
		const target = isBrowsableUrl(displayedUrl)
			? displayedUrl
			: isBrowsableUrl(url)
				? url
				: null;
		if (!target) return;
		try {
			await globalThis.electronAPI.openExternal(target);
		} catch (failure) {
			const reason =
				failure instanceof Error ? failure.message : String(failure);
			setBrowserError(
				`${t("appEmulator:preview.browserFailed", { url: target })} ${reason}`.trim(),
			);
		}
	}, [displayedUrl, url, t]);

	if (!emulatorPath) {
		return (
			<div className="h-full flex items-center justify-center p-8 text-center">
				<div className="space-y-3">
					<Monitor className="mx-auto h-10 w-10 text-muted-foreground/40" />
					<h3 className="text-base font-semibold">
						{t("tasks:emulator.noProjectTitle")}
					</h3>
					<p className="max-w-md text-sm text-muted-foreground">
						{t("tasks:emulator.noProjectDescription")}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="shrink-0 border-b border-border p-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold">
								{t("tasks:emulator.title")}
							</h3>
							<Badge
								variant={
									isRunning ? "success" : isLoading ? "warning" : "muted"
								}
							>
								{isRunning
									? t("appEmulator:running")
									: isLoading
										? t("appEmulator:starting")
										: t("appEmulator:idle")}
							</Badge>
							{config && (
								<Badge variant="outline">
									{config.framework}
									{config.port > 0 ? ` :${config.port}` : ""}
								</Badge>
							)}
						</div>
						<p className="text-sm text-muted-foreground">
							{t("tasks:emulator.description")}
						</p>
						{status && (
							<p className="text-xs text-muted-foreground">{status}</p>
						)}
						<p className="text-xs text-muted-foreground">
							{t("tasks:emulator.runtimePath")}: {emulatorPath}
						</p>
						{canPreview && landing && (
							<p className="text-xs text-muted-foreground">
								{t("appEmulator:preview.featureRoute", { path: landing.path })}{" "}
								<span className="text-muted-foreground/70">
									({t(LANDING_SOURCE_KEYS[landing.source])})
								</span>
							</p>
						)}
						{isOtherProject && (
							<p className="text-xs text-warning">
								{t("tasks:emulator.otherProjectWarning")}
							</p>
						)}
					</div>
					<div className="flex flex-wrap gap-2">
						{canPreview && (
							<>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setRefreshKey((value) => value + 1)}
								>
									<RefreshCw className="mr-2 h-4 w-4" />
									{t("appEmulator:actions.refresh")}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleOpenInBrowser}
								>
									<ExternalLink className="mr-2 h-4 w-4" />
									{t("appEmulator:actions.openInBrowser")}
								</Button>
							</>
						)}
						{isRunning || isLoading ? (
							<Button
								type="button"
								variant="destructive"
								size="sm"
								onClick={handleStop}
							>
								<Square className="mr-2 h-4 w-4" />
								{t("appEmulator:actions.stop")}
							</Button>
						) : (
							<Button type="button" size="sm" onClick={handleStart}>
								<Play className="mr-2 h-4 w-4" />
								{t("appEmulator:actions.start")}
							</Button>
						)}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleRestart}
							disabled={isLoading}
						>
							{isLoading ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<RefreshCw className="mr-2 h-4 w-4" />
							)}
							{t("appEmulator:actions.restart")}
						</Button>
					</div>
				</div>
			</div>

			{browserError && (
				<p
					role="alert"
					className="shrink-0 border-b border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
				>
					{browserError}
				</p>
			)}
			<div className="flex-1 min-h-0 overflow-hidden">
				{canPreview && url ? (
					<ResponsivePreview
						url={url}
						refreshKey={refreshKey}
						landingPath={landing?.path ?? null}
						candidates={landingCandidates}
						restoredUrl={previewUrl}
						onNavigate={handlePreviewNavigate}
					/>
				) : (
					<div className="flex h-full flex-col">
						<div className="flex items-center gap-2 border-b border-border px-4 py-2">
							<Terminal className="h-4 w-4 text-muted-foreground" />
							<span className="text-sm font-medium">
								{t("appEmulator:output.title")}
							</span>
						</div>
						<ScrollArea className="flex-1">
							<pre className="m-4 rounded-lg bg-muted/50 p-3 text-xs font-mono whitespace-pre-wrap text-foreground">
								{error || formattedOutput}
							</pre>
						</ScrollArea>
					</div>
				)}
			</div>

			{canPreview && (
				<details className="shrink-0 border-t border-border p-2 text-sm">
					<summary className="cursor-pointer">
						{t("appEmulator:output.title")}
					</summary>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap p-2 text-xs">
						{error || formattedOutput}
					</pre>
				</details>
			)}
			<div className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground">
				{t("tasks:emulator.persistenceHint")}
			</div>
		</div>
	);
}

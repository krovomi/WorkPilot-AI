import {
	ArrowLeft,
	ArrowRight,
	Home,
	RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	buildLandingUrl,
	type LandingGuess,
	resolveAddressInput,
} from "../../../shared/utils/emulator-landing";
import { Button } from "../ui/button";

const FORMATS = [
	{ id: "phone", width: 390, height: 844 },
	{ id: "phoneSmall", width: 360, height: 640 },
	{ id: "phoneLarge", width: 430, height: 932 },
	{ id: "tablet", width: 768, height: 1024 },
	{ id: "desktop", width: 1440, height: 900 },
	...[640, 768, 1024, 1280, 1536].map((width) => ({
		id: `bp${width}`,
		width,
		height: 900,
	})),
];

/**
 * Le `<webview>` d'Electron a gardé les méthodes historiques et gagné
 * `navigationHistory`. On demande les deux : la version installée décide, pas
 * nous — et un aperçu qui plante parce qu'une méthode a été retirée coûte la
 * page entière pour deux boutons.
 */
type NavigationTarget = Electron.WebviewTag & {
	navigationHistory?: {
		canGoBack?: () => boolean;
		canGoForward?: () => boolean;
		goBack?: () => void;
		goForward?: () => void;
	};
};

function historyCall(
	view: Electron.WebviewTag | null,
	action: "canGoBack" | "canGoForward" | "goBack" | "goForward",
): boolean {
	if (!view) return false;
	const target = view as NavigationTarget;
	const history = target.navigationHistory;
	const modern = history?.[action] as undefined | (() => unknown);
	if (typeof modern === "function") {
		return Boolean(modern.call(history));
	}
	const legacy = (target as unknown as Record<string, unknown>)[action];
	if (typeof legacy === "function") {
		return Boolean((legacy as () => unknown).call(target));
	}
	return false;
}

/**
 * Charge une adresse sans remplacer le nœud : remonter le `<webview>` perdrait
 * l'historique, et l'historique est ce que les boutons Précédent/Suivant
 * lisent. `src` reste le repli — c'est tout ce dont dispose un environnement de
 * test, et c'est aussi ce qui fait la première navigation.
 */
function loadInView(view: Electron.WebviewTag | null, target: string): void {
	if (!view) return;
	const load = (view as unknown as { loadURL?: (url: string) => Promise<void> })
		.loadURL;
	if (typeof load === "function") {
		void Promise.resolve(load.call(view, target)).catch(() => {
			// L'échec remonte par `did-fail-load`, qui sait déjà quoi en dire.
		});
		return;
	}
	view.setAttribute("src", target);
}

/** L'étiquette lisible d'une route proposée par la tâche. */
const SOURCE_KEYS: Record<LandingGuess["source"], string> = {
	"route-declaration": "preview.routeSource.declared",
	"file-route": "preview.routeSource.page",
	"launch-profile": "preview.routeSource.launchProfile",
	"api-docs": "preview.routeSource.apiDocs",
};

interface ResponsivePreviewProps {
	/** La racine du serveur lancé par l'émulateur. */
	url: string;
	refreshKey: number;
	/** Le chemin que la tâche a touché, quand on a pu le déduire. */
	landingPath?: string | null;
	/** Les autres adresses plausibles, proposées quand celle-ci ne répond pas. */
	candidates?: readonly LandingGuess[];
	/** L'adresse réellement affichée, pour « Ouvrir dans le navigateur ». */
	onNavigate?: (url: string) => void;
}

/** CSS viewport simulation: dimensions change media queries, zoom only scales the preview. */
export function ResponsivePreview({
	url,
	refreshKey,
	landingPath,
	candidates,
	onNavigate,
}: ResponsivePreviewProps) {
	const { t } = useTranslation("appEmulator");
	const viewRef = useRef<Electron.WebviewTag>(null);
	const [format, setFormat] = useState("fluid");
	const [size, setSize] = useState({ width: 390, height: 844 });
	const [zoom, setZoom] = useState(1);
	const [loading, setLoading] = useState(true);
	const [failure, setFailure] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);

	const homeUrl = useMemo(
		() => buildLandingUrl(url, landingPath),
		[url, landingPath],
	);
	const [currentUrl, setCurrentUrl] = useState(homeUrl);
	const [address, setAddress] = useState(homeUrl);
	const [history, setHistory] = useState({ back: false, forward: false });

	// Un nouveau serveur — ou une nouvelle route de tâche — est une autre page.
	useEffect(() => {
		setCurrentUrl(homeUrl);
		setAddress(homeUrl);
		setHistory({ back: false, forward: false });
	}, [homeUrl]);

	useEffect(() => {
		onNavigate?.(currentUrl);
	}, [currentUrl, onNavigate]);

	const navigate = useCallback((target: string) => {
		setFailure(null);
		setCurrentUrl(target);
		setAddress(target);
		loadInView(viewRef.current, target);
	}, []);

	const submitAddress = useCallback(() => {
		const resolved = resolveAddressInput(address, currentUrl || url);
		if (!resolved) {
			setFailure(t("preview.addressInvalid"));
			return;
		}
		navigate(resolved);
	}, [address, currentUrl, navigate, t, url]);

	// The key replaces the webview DOM node, so each replacement needs fresh listeners.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reattach after keyed webview replacement
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		let timer: ReturnType<typeof setTimeout>;
		const syncHistory = () => {
			setHistory({
				back: historyCall(view, "canGoBack"),
				forward: historyCall(view, "canGoForward"),
			});
		};
		const start = () => {
			clearTimeout(timer);
			setLoading(true);
			setFailure(null);
			timer = setTimeout(() => {
				setLoading(false);
				setFailure(t("preview.timeout"));
			}, 30000);
		};
		const finish = () => {
			clearTimeout(timer);
			setLoading(false);
			syncHistory();
		};
		const fail = (event: Event) => {
			const details = event as Electron.DidFailLoadEvent;
			if (details.errorCode === -3 || details.isMainFrame === false) return;
			finish();
			setFailure(
				`${t("preview.failed")} ${details.errorDescription || details.errorCode}`,
			);
		};
		/** Une navigation interne à l'aperçu : la barre d'adresse la suit. */
		const track = (event: Event) => {
			const visited = (event as Event & { url?: string }).url;
			if (!visited) return;
			setCurrentUrl(visited);
			setAddress(visited);
			syncHistory();
		};
		const navigated = (event: Event) => {
			track(event);
			const code = (event as Event & { httpResponseCode: number })
				.httpResponseCode;
			if (code >= 400) {
				finish();
				setFailure(
					t(code === 404 ? "preview.notFound" : "preview.httpError", { code }),
				);
			} else if (code >= 200) {
				finish();
				setFailure(null);
			}
		};
		const crash = () => {
			finish();
			setFailure(t("preview.crashed"));
		};
		view.addEventListener("did-start-loading", start);
		view.addEventListener("did-stop-loading", finish);
		view.addEventListener("did-fail-load", fail);
		view.addEventListener("render-process-gone", crash);
		view.addEventListener("did-navigate", navigated);
		view.addEventListener("did-navigate-in-page", track);
		start();
		return () => {
			clearTimeout(timer);
			view.removeEventListener("did-start-loading", start);
			view.removeEventListener("did-stop-loading", finish);
			view.removeEventListener("did-fail-load", fail);
			view.removeEventListener("render-process-gone", crash);
			view.removeEventListener("did-navigate", navigated);
			view.removeEventListener("did-navigate-in-page", track);
		};
	}, [homeUrl, refreshKey, retry, t]);

	const fluid = format === "fluid";
	const controlClass =
		"rounded-md border border-input bg-background px-2 py-1 text-sm";
	// Les autres adresses de la tâche, celle qu'on regarde exclue.
	const alternatives = (candidates ?? []).filter(
		(candidate) => buildLandingUrl(url, candidate.path) !== currentUrl,
	);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
				<Button
					size="icon"
					variant="ghost"
					className="h-8 w-8"
					aria-label={t("preview.back")}
					title={t("preview.back")}
					disabled={!history.back}
					onClick={() => historyCall(viewRef.current, "goBack")}
				>
					<ArrowLeft className="h-4 w-4" />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					className="h-8 w-8"
					aria-label={t("preview.forward")}
					title={t("preview.forward")}
					disabled={!history.forward}
					onClick={() => historyCall(viewRef.current, "goForward")}
				>
					<ArrowRight className="h-4 w-4" />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					className="h-8 w-8"
					aria-label={t("preview.reload")}
					title={t("preview.reload")}
					onClick={() => navigate(currentUrl)}
				>
					<RotateCw className="h-4 w-4" />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					className="h-8 w-8"
					aria-label={t("preview.home")}
					title={
						landingPath
							? t("preview.homeFeature", { path: landingPath })
							: t("preview.home")
					}
					onClick={() => navigate(homeUrl)}
				>
					<Home className="h-4 w-4" />
				</Button>
				<label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
					<span className="sr-only">{t("preview.address")}</span>
					<input
						className={`${controlClass} min-w-0 flex-1 font-mono`}
						type="text"
						spellCheck={false}
						autoComplete="off"
						value={address}
						placeholder={t("preview.addressPlaceholder")}
						onChange={(event) => setAddress(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submitAddress();
							}
							if (event.key === "Escape") setAddress(currentUrl);
						}}
					/>
				</label>
				<Button size="sm" variant="outline" onClick={submitAddress}>
					{t("preview.go")}
				</Button>
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border p-2">
				<label className="flex items-center gap-2 text-sm">
					{t("preview.format")}
					<select
						className={controlClass}
						value={format}
						onChange={(event) => {
							setFormat(event.target.value);
							const selected = FORMATS.find(
								(item) => item.id === event.target.value,
							);
							if (selected)
								setSize({ width: selected.width, height: selected.height });
						}}
					>
						<option value="fluid">{t("preview.fluid")}</option>
						{FORMATS.map((item) => (
							<option key={item.id} value={item.id}>
								{item.id.startsWith("bp")
									? t("preview.breakpoint", { width: item.width })
									: t(`preview.${item.id}`)}{" "}
								— {item.width} × {item.height}
							</option>
						))}
						<option value="custom">{t("preview.custom")}</option>
					</select>
				</label>
				{!fluid && (
					<>
						{(["width", "height"] as const).map((axis) => (
							<DimensionInput
								key={axis}
								label={t(`preview.${axis}`)}
								value={size[axis]}
								className={`${controlClass} w-20`}
								onCommit={(value) => {
									setSize((current) => ({ ...current, [axis]: value }));
									setFormat("custom");
								}}
							/>
						))}
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								setSize((current) => ({
									width: current.height,
									height: current.width,
								}));
								setFormat("custom");
							}}
						>
							{t("preview.rotate")}
						</Button>
						<label className="flex items-center gap-1 text-sm">
							{t("preview.zoom")}
							<select
								className={controlClass}
								value={zoom}
								onChange={(event) => setZoom(Number(event.target.value))}
							>
								{[0.25, 0.5, 0.75, 1].map((value) => (
									<option key={value} value={value}>
										{value * 100}%
									</option>
								))}
							</select>
						</label>
					</>
				)}
			</div>
			{loading && (
				<div
					role="status"
					className="shrink-0 p-2 text-sm text-muted-foreground"
				>
					{t("preview.loading")}
				</div>
			)}
			{failure && (
				<div
					role="alert"
					className="shrink-0 space-y-2 border-b border-border p-3 text-sm"
				>
					<p>{failure}</p>
					<p className="break-all text-muted-foreground">{currentUrl}</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => setRetry((value) => value + 1)}
						>
							{t("actions.retry")}
						</Button>
						{alternatives.map((candidate) => (
							<Button
								key={candidate.path}
								size="sm"
								variant="ghost"
								onClick={() => navigate(buildLandingUrl(url, candidate.path))}
							>
								{candidate.path}
								<span className="ml-2 text-xs text-muted-foreground">
									{t(SOURCE_KEYS[candidate.source])}
								</span>
							</Button>
						))}
					</div>
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto bg-muted/30">
				<div
					className="mx-auto"
					style={
						fluid
							? { width: "100%", height: "100%" }
							: { width: size.width * zoom, height: size.height * zoom }
					}
				>
					<webview
						key={`${homeUrl}-${refreshKey}-${retry}`}
						ref={viewRef}
						src={homeUrl}
						className="border-0 bg-white"
						style={{
							display: "flex",
							flexShrink: 0,
							width: fluid ? "100%" : size.width,
							height: fluid ? "100%" : size.height,
							transform: fluid ? undefined : `scale(${zoom})`,
							transformOrigin: "top left",
						}}
					/>
				</div>
			</div>
		</div>
	);
}

function DimensionInput({
	label,
	value,
	className,
	onCommit,
}: {
	label: string;
	value: number;
	className: string;
	onCommit: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	return (
		<label className="flex items-center gap-1 text-sm">
			{label}
			<input
				className={className}
				type="number"
				min={240}
				max={3840}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					const parsed = Number(draft);
					if (!draft.trim() || !Number.isFinite(parsed)) {
						setDraft(String(value));
						return;
					}
					const next = Math.min(3840, Math.max(240, Math.round(parsed)));
					setDraft(String(next));
					onCommit(next);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") event.currentTarget.blur();
				}}
			/>
		</label>
	);
}

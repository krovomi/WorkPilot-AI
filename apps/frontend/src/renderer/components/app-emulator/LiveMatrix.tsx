import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_LIVE_VIEWS, orientDevice } from "../../../shared/constants/device-presets";
import type { LiveScroll, LiveViewError } from "../../../shared/types/device-library";
import type { DeviceOrientation, DevicePreset } from "../../../shared/types/device-matrix";

/** La largeur d'une vue à l'écran : un appareil plus large est réduit. */
export const LIVE_TILE_WIDTH = 360;
/** Le rythme auquel la vue qu'on manipule est relue pour défiler les autres. */
export const SCROLL_SYNC_MS = 250;

type LiveWebview = Electron.WebviewTag & {
	getWebContentsId?: () => number;
	loadURL?: (url: string) => Promise<void>;
	reload?: () => void;
	getURL?: () => string;
};

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function idOf(view: LiveWebview): number | null {
	try {
		const id = view.getWebContentsId?.();
		return typeof id === "number" ? id : null;
	} catch {
		return null; // pas encore attaché
	}
}

interface LiveMatrixProps {
	serverUrl: string;
	/** Le chemin que la matrice rend. */
	path: string;
	/** Les appareils cochés ; les `MAX_LIVE_VIEWS` premiers sont montrés. */
	devices: readonly DevicePreset[];
	orientation: DeviceOrientation;
	/** Change quand l'aperçu est rechargé : toutes les vues se rechargent ensemble. */
	refreshKey?: number;
	deviceName: (device: DevicePreset) => string;
}

/**
 * Les appareils cochés, vivants, côte à côte : un `<webview>` par appareil sur
 * la page du serveur de l'émulateur, émulé par le main. Naviguer dans l'un
 * mène les autres à la même adresse ; défiler l'un défile les autres à la
 * même part de la page ; le serveur de dev recharge chacun à chaud, et le
 * bouton de rechargement de l'aperçu les recharge tous.
 */
export function LiveMatrix({ serverUrl, path, devices, orientation, refreshKey = 0, deviceName }: LiveMatrixProps) {
	const { t } = useTranslation("appEmulator");
	const [synced, setSynced] = useState(true);
	const [errors, setErrors] = useState<Record<string, LiveViewError>>({});
	const views = useRef(new Map<string, LiveWebview>());
	const leader = useRef<string | null>(null);
	const lastUrl = useRef<string | null>(null);
	const origin = originOf(serverUrl);
	const shown = devices.slice(0, MAX_LIVE_VIEWS);
	const src = origin ? `${origin}${path}` : serverUrl;

	const register = useCallback((id: string, view: LiveWebview | null) => {
		if (view) views.current.set(id, view);
		else views.current.delete(id);
	}, []);

	const report = useCallback((id: string, error: LiveViewError | null) => {
		setErrors((current) => {
			const next = { ...current };
			if (error) next[id] = error;
			else delete next[id];
			return next;
		});
	}, []);

	const navigated = useCallback(
		(source: string, url: unknown) => {
			if (!synced || typeof url !== "string" || url === lastUrl.current || originOf(url) !== origin) return;
			lastUrl.current = url;
			for (const [id, view] of views.current) {
				if (id !== source && view.getURL?.() !== url) void view.loadURL?.(url)?.catch(() => undefined);
			}
		},
		[synced, origin],
	);

	// Le défilement de la vue qu'on manipule, relu et porté aux autres.
	useEffect(() => {
		if (!synced) return;
		let busy = false;
		let last: LiveScroll | null = null;
		const timer = setInterval(() => {
			if (busy || views.current.size < 2) return;
			const entries = [...views.current.entries()];
			const lead = entries.find(([id]) => id === leader.current) ?? entries[0];
			const leadId = idOf(lead[1]);
			const others = entries
				.filter(([id]) => id !== lead[0])
				.map(([, view]) => idOf(view))
				.filter((id): id is number => id !== null);
			if (leadId === null || others.length === 0) return;
			busy = true;
			void (async () => {
				try {
					const read = await globalThis.electronAPI.readEmulatorLiveScroll(leadId);
					if (!read.success || (last && last.x === read.data.x && last.y === read.data.y)) return;
					last = read.data;
					await globalThis.electronAPI.setEmulatorLiveScroll({ webContentsIds: others, ...read.data });
				} catch {
					// une vue partie entre deux relectures : la suivante repart de zéro
				} finally {
					busy = false;
				}
			})();
		}, SCROLL_SYNC_MS);
		return () => clearInterval(timer);
	}, [synced]);

	// Le rechargement de l'aperçu recharge toutes les vues, ensemble.
	const lastRefresh = useRef(refreshKey);
	useEffect(() => {
		if (lastRefresh.current === refreshKey) return;
		lastRefresh.current = refreshKey;
		for (const view of views.current.values()) view.reload?.();
	}, [refreshKey]);

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-3 text-xs">
				<label className="flex items-center gap-2 text-sm">
					<input type="checkbox" checked={synced} onChange={(event) => setSynced(event.target.checked)} />
					{t("matrix.live.sync")}
				</label>
				<p className="text-muted-foreground">{t("matrix.live.hint")}</p>
				{devices.length > MAX_LIVE_VIEWS && (
					<p role="status" className="text-warning">
						{t("matrix.live.capped", { count: MAX_LIVE_VIEWS })}
					</p>
				)}
			</div>
			{shown.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("matrix.live.empty")}</p>
			) : (
				<div className="flex flex-wrap items-start gap-3">
					{shown.map((device) => (
						<LiveView
							key={`${device.id}-${orientation}`}
							device={orientDevice(device, orientation)}
							orientation={orientation}
							src={src}
							name={deviceName(device)}
							error={errors[device.id] ?? null}
							register={register}
							report={report}
							onNavigate={navigated}
							onLead={(id) => {
								leader.current = id;
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}

interface LiveViewProps {
	device: DevicePreset;
	orientation: DeviceOrientation;
	src: string;
	name: string;
	error: LiveViewError | null;
	register: (id: string, view: LiveWebview | null) => void;
	report: (id: string, error: LiveViewError | null) => void;
	onNavigate: (id: string, url: unknown) => void;
	onLead: (id: string) => void;
}

function LiveView({ device, orientation, src, name, error, register, report, onNavigate, onLead }: LiveViewProps): ReactNode {
	const { t } = useTranslation("appEmulator");
	const ref = useRef<LiveWebview | null>(null);
	const scale = Math.min(1, LIVE_TILE_WIDTH / device.width);
	const navigate = useRef(onNavigate);
	navigate.current = onNavigate;
	const lead = useRef(onLead);
	lead.current = onLead;

	useEffect(() => {
		// React pose la référence avant de lancer l'effet.
		const view = ref.current as LiveWebview;
		register(device.id, view);
		const ready = () => {
			const id = idOf(view);
			if (id === null) return;
			void globalThis.electronAPI
				.emulateEmulatorLiveView({ webContentsId: id, deviceId: device.id, orientation })
				.then((result) => report(device.id, result.success ? null : result.error))
				.catch(() => report(device.id, "emulation-failed"));
		};
		const moved = (event: Event) => navigate.current(device.id, (event as Event & { url?: unknown }).url);
		// La vue qu'on survole ou qui a le focus mène le défilement des autres.
		const leads = () => lead.current(device.id);
		view.addEventListener("dom-ready", ready);
		view.addEventListener("mouseenter", leads);
		view.addEventListener("focus", leads);
		view.addEventListener("did-navigate", moved);
		view.addEventListener("did-navigate-in-page", moved);
		return () => {
			view.removeEventListener("dom-ready", ready);
			view.removeEventListener("did-navigate", moved);
			view.removeEventListener("did-navigate-in-page", moved);
			view.removeEventListener("mouseenter", leads);
			view.removeEventListener("focus", leads);
			register(device.id, null);
		};
	}, [device.id, orientation, register, report]);

	return (
		<figure
			className="space-y-1 rounded-md border border-border bg-card p-2"
			data-live-device={device.id}
		>
			<figcaption className="text-sm font-medium">{name}</figcaption>
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{t(`matrix.live.errors.${error}`)}
				</p>
			)}
			<div className="overflow-hidden" style={{ width: device.width * scale, height: device.height * scale }}>
				<webview
					ref={ref}
					src={src}
					className="border-0 bg-white"
					style={{
						display: "flex",
						width: device.width,
						height: device.height,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
				/>
			</div>
		</figure>
	);
}

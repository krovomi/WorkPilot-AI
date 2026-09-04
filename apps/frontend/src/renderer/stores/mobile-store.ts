import { create } from "zustand";
import type {
	MobileDevice,
	MobilePlan,
	MobilePlatform,
	MobileSessionPhase,
} from "../../shared/types/mobile";

/**
 * State of the mobile preview — the phone equivalent of `app-emulator-store`.
 *
 * The difference that shapes it: a web preview has one thing to remember (the
 * URL), a phone preview has three (which platform, which device, and the last
 * frame captured from it). Losing the device selection between two renders is
 * what makes a preview panel feel broken, so it lives here rather than in the
 * component.
 */
interface MobileState {
	plan: MobilePlan | null;
	phase: MobileSessionPhase;
	platform: MobilePlatform | null;
	device: MobileDevice | null;
	screenshot: string | null;
	output: string;
	status: string;
	error: string | null;

	setPlan: (plan: MobilePlan) => void;
	setPhase: (phase: MobileSessionPhase) => void;
	selectPlatform: (platform: MobilePlatform) => void;
	selectDevice: (device: MobileDevice | null) => void;
	setScreenshot: (dataUri: string) => void;
	appendOutput: (line: string) => void;
	setStatus: (status: string) => void;
	setError: (error: string | null) => void;
	reset: () => void;
}

/** Enough to diagnose a failed build; more than that is a log viewer's job. */
const OUTPUT_LINE_CAP = 400;

const initialState = {
	plan: null as MobilePlan | null,
	phase: "idle" as MobileSessionPhase,
	platform: null as MobilePlatform | null,
	device: null as MobileDevice | null,
	screenshot: null as string | null,
	output: "",
	status: "",
	error: null as string | null,
};

/**
 * The device to preselect: one already booted, on the wanted platform.
 *
 * Preselecting a shut-down emulator means the first click on "Run" spends a
 * minute booting one while a booted one sits next to it in the list.
 */
export function preferredDevice(
	devices: MobileDevice[],
	platform: MobilePlatform,
): MobileDevice | null {
	const forPlatform = devices.filter((device) => device.platform === platform);
	return forPlatform.find((device) => device.isBooted) ?? forPlatform[0] ?? null;
}

/**
 * The platform to open on: the first one the project targets that this machine
 * can actually build. Opening on a platform the machine cannot build shows an
 * error before the user has chosen anything.
 */
export function preferredPlatform(
	plan: MobilePlan | null,
): MobilePlatform | null {
	const platforms = plan?.stack?.platforms ?? [];
	const buildable = platforms.find((platform) => plan?.platforms?.[platform]?.ok);
	return buildable ?? platforms[0] ?? null;
}

export const useMobileStore = create<MobileState>((set, get) => ({
	...initialState,

	setPlan: (plan) =>
		set((state) => {
			const platform = state.platform ?? preferredPlatform(plan);
			const device =
				platform && plan.devices
					? // Keep the current device when it is still in the list: a device
						// refresh must not silently move the selection elsewhere.
						(plan.devices.find((d) => d.id === state.device?.id) ??
							preferredDevice(plan.devices, platform))
					: null;
			return { plan, platform, device };
		}),

	setPhase: (phase) => set({ phase }),

	selectPlatform: (platform) =>
		set((state) => ({
			platform,
			device: preferredDevice(state.plan?.devices ?? [], platform),
			// The frame on screen belongs to the platform we are leaving.
			screenshot: null,
		})),

	selectDevice: (device) => set({ device }),

	setScreenshot: (screenshot) => set({ screenshot }),

	appendOutput: (line) => {
		const lines = get().output ? get().output.split("\n") : [];
		lines.push(line);
		set({ output: lines.slice(-OUTPUT_LINE_CAP).join("\n") });
	},

	setStatus: (status) => set({ status }),
	setError: (error) => set({ error }),
	reset: () => set({ ...initialState }),
}));

/**
 * Bind the store to the main process's events.
 *
 * Ref-counted like `app-emulator-store`: the task panel and the board can both
 * mount a consumer, and a second subscription would double every log line.
 */
let listenerRefCount = 0;
let teardown: (() => void) | null = null;

export function setupMobileListeners(): () => void {
	listenerRefCount += 1;
	if (!teardown) {
		const api = globalThis.electronAPI;
		const unsubscribers = [
			api.onMobilePlan((plan) => useMobileStore.getState().setPlan(plan)),
			api.onMobilePhase((phase) => useMobileStore.getState().setPhase(phase)),
			api.onMobileStatus((status) =>
				useMobileStore.getState().setStatus(status),
			),
			api.onMobileOutput((line) => useMobileStore.getState().appendOutput(line)),
			api.onMobileScreenshot((dataUri) =>
				useMobileStore.getState().setScreenshot(dataUri),
			),
			api.onMobileError((error) => useMobileStore.getState().setError(error)),
			api.onMobileStopped(() => useMobileStore.getState().setPhase("stopped")),
		];
		teardown = () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}

	return () => {
		listenerRefCount -= 1;
		if (listenerRefCount <= 0 && teardown) {
			teardown();
			teardown = null;
			listenerRefCount = 0;
		}
	};
}

export async function detectMobileProject(projectDir: string): Promise<void> {
	const store = useMobileStore.getState();
	store.setError(null);
	store.setPhase("detecting");
	const result = await globalThis.electronAPI.detectMobileProject(projectDir);
	if (result.success && result.data) {
		store.setPlan(result.data);
		if (result.data.error) store.setError(result.data.error);
	} else {
		store.setError(result.error ?? "Detection failed");
	}
	store.setPhase("idle");
}

export async function launchMobileApp(projectDir: string): Promise<void> {
	const store = useMobileStore.getState();
	const { platform, device } = store;
	if (!platform || !device) return;
	store.setError(null);
	const result = await globalThis.electronAPI.launchMobileApp(
		projectDir,
		platform,
		device,
	);
	if (!result.success) {
		store.setError(result.error ?? "Launch failed");
		store.setPhase("error");
	}
}

export async function refreshMobileScreenshot(): Promise<void> {
	const { platform, device, setScreenshot, setError } =
		useMobileStore.getState();
	if (!platform || !device) return;
	const result = await globalThis.electronAPI.captureMobileScreenshot(
		platform,
		device,
	);
	if (result.success && result.data) setScreenshot(result.data);
	else if (result.error) setError(result.error);
}

export async function stopMobileSession(): Promise<void> {
	await globalThis.electronAPI.stopMobileSession();
	useMobileStore.getState().setPhase("stopped");
}

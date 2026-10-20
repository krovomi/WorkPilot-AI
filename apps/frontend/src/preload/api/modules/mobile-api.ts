import { ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type {
	MobileDevice,
	MobilePlan,
	MobilePlatform,
	MobileSessionPhase,
} from "../../../shared/types/mobile";

interface MobileStatus {
	phase: MobileSessionPhase;
	platform: MobilePlatform | null;
	deviceId: string | null;
	output: string;
	plan: MobilePlan | null;
}

export interface MobileAPI {
	/**
	 * Detect the mobile stack, the available devices and whether each platform
	 * can be built on this machine — one call, so the panel's three answers
	 * cannot disagree about which project they describe.
	 */
	detectMobileProject: (
		projectDir: string,
	) => Promise<{ success: boolean; data?: MobilePlan; error?: string }>;

	/** Re-read the device list; it changes as emulators boot. */
	refreshMobileDevices: (
		projectDir: string,
		platforms?: MobilePlatform[],
	) => Promise<{ success: boolean; data?: MobilePlan; error?: string }>;

	/** Boot the device if needed, build, install, launch, capture a frame. */
	launchMobileApp: (
		projectDir: string,
		platform: MobilePlatform,
		device: MobileDevice,
	) => Promise<{ success: boolean; error?: string }>;

	/** A fresh frame from the device — the phone's equivalent of a reload. */
	captureMobileScreenshot: (
		platform: MobilePlatform,
		device: MobileDevice,
	) => Promise<{ success: boolean; data?: string; error?: string }>;

	/** End the session. The device itself is left booted. */
	stopMobileSession: () => Promise<{ success: boolean }>;

	getMobileStatus: () => Promise<{ success: boolean; data?: MobileStatus }>;

	onMobilePlan: (callback: (plan: MobilePlan) => void) => () => void;
	onMobilePhase: (callback: (phase: MobileSessionPhase) => void) => () => void;
	onMobileStatus: (callback: (status: string) => void) => () => void;
	onMobileOutput: (callback: (line: string) => void) => () => void;
	onMobileScreenshot: (callback: (dataUri: string) => void) => () => void;
	onMobileError: (callback: (error: string) => void) => () => void;
	onMobileStopped: (callback: () => void) => () => void;
}

function subscribe<T extends unknown[]>(
	channel: string,
	callback: (...args: T) => void,
): () => void {
	const handler = (_event: Electron.IpcRendererEvent, ...args: T) =>
		callback(...args);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

export function createMobileAPI(): MobileAPI {
	return {
		detectMobileProject: (projectDir) =>
			ipcRenderer.invoke(IPC_CHANNELS.MOBILE_DETECT, { projectDir }),

		refreshMobileDevices: (projectDir, platforms) =>
			ipcRenderer.invoke(IPC_CHANNELS.MOBILE_DEVICES, { projectDir, platforms }),

		launchMobileApp: (projectDir, platform, device) =>
			ipcRenderer.invoke(IPC_CHANNELS.MOBILE_LAUNCH, { projectDir, platform, device }),

		captureMobileScreenshot: (platform, device) =>
			ipcRenderer.invoke(IPC_CHANNELS.MOBILE_SCREENSHOT, { platform, device }),

		stopMobileSession: () => ipcRenderer.invoke(IPC_CHANNELS.MOBILE_STOP),

		getMobileStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MOBILE_STATUS),

		onMobilePlan: (callback) => subscribe(IPC_CHANNELS.MOBILE_PLAN_EVENT, callback),
		onMobilePhase: (callback) => subscribe(IPC_CHANNELS.MOBILE_PHASE_EVENT, callback),
		onMobileStatus: (callback) => subscribe(IPC_CHANNELS.MOBILE_STATUS_EVENT, callback),
		onMobileOutput: (callback) => subscribe(IPC_CHANNELS.MOBILE_OUTPUT_EVENT, callback),
		onMobileScreenshot: (callback) =>
			subscribe(IPC_CHANNELS.MOBILE_SCREENSHOT_EVENT, callback),
		onMobileError: (callback) => subscribe(IPC_CHANNELS.MOBILE_ERROR_EVENT, callback),
		onMobileStopped: (callback) => subscribe(IPC_CHANNELS.MOBILE_STOPPED_EVENT, callback),
	};
}

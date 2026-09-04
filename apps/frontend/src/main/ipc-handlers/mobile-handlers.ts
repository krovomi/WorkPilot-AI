import { type BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	MobileDevice,
	MobilePlan,
	MobilePlatform,
	MobileSessionPhase,
} from "../../shared/types/mobile";
import { mobileService } from "../mobile-service";

/**
 * IPC for building smartphone applications from the Kanban.
 *
 * Deliberately separate from the App Emulator's channels rather than folded
 * into them: the two answer different questions ("what URL" vs "which device"),
 * and a `start` that means one thing for a web project and another for a phone
 * one is a channel nobody can reason about.
 */
export function registerMobileHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	ipcMain.handle(
		IPC_CHANNELS.MOBILE_DETECT,
		async (_event, { projectDir }: { projectDir: string }) => {
			try {
				return { success: true, data: await mobileService.detect(projectDir) };
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MOBILE_DEVICES,
		async (
			_event,
			{
				projectDir,
				platforms,
			}: { projectDir: string; platforms?: MobilePlatform[] },
		) => {
			try {
				return {
					success: true,
					data: await mobileService.refreshDevices(projectDir, platforms),
				};
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);

	// One launch at a time: two builds writing into the same output directory
	// race, and the second failure reads like a code error.
	let launchLock = false;
	ipcMain.handle(
		IPC_CHANNELS.MOBILE_LAUNCH,
		async (
			_event,
			{
				projectDir,
				platform,
				device,
			}: {
				projectDir: string;
				platform: MobilePlatform;
				device: MobileDevice;
			},
		) => {
			if (launchLock) {
				return {
					success: false,
					error: "A launch is already in progress.",
				};
			}
			launchLock = true;
			try {
				return await mobileService.launch(projectDir, platform, device);
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			} finally {
				launchLock = false;
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.MOBILE_SCREENSHOT,
		async (
			_event,
			{ platform, device }: { platform: MobilePlatform; device: MobileDevice },
		) => {
			const data = await mobileService.captureScreenshot(platform, device);
			return data
				? { success: true, data }
				: {
						success: false,
						error:
							"No frame could be captured. The device may have stopped, or the app may not be in the foreground.",
					};
		},
	);

	ipcMain.handle(IPC_CHANNELS.MOBILE_STOP, async () => {
		launchLock = false;
		mobileService.stop();
		return { success: true };
	});

	ipcMain.handle(IPC_CHANNELS.MOBILE_STATUS, async () => ({
		success: true,
		data: { ...mobileService.getState(), plan: mobileService.getPlan() },
	}));

	const sendToRenderer = (channel: string, ...args: unknown[]) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, ...args);
		}
	};

	mobileService.on("plan", (plan: MobilePlan) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_PLAN_EVENT, plan),
	);
	mobileService.on("phase", (phase: MobileSessionPhase) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_PHASE_EVENT, phase),
	);
	mobileService.on("status", (status: string) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_STATUS_EVENT, status),
	);
	mobileService.on("output", (line: string) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_OUTPUT_EVENT, line),
	);
	mobileService.on("screenshot", (dataUri: string) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_SCREENSHOT_EVENT, dataUri),
	);
	mobileService.on("error", (message: string) =>
		sendToRenderer(IPC_CHANNELS.MOBILE_ERROR_EVENT, message),
	);
	mobileService.on("stopped", () => sendToRenderer(IPC_CHANNELS.MOBILE_STOPPED_EVENT));
}

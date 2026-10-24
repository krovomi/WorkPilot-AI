import { type BrowserWindow, ipcMain } from "electron";
import {
	type AppEmulatorConfig,
	appEmulatorService,
} from "../app-emulator-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Register App Emulator IPC handlers and event forwarding.
 */
export function registerAppEmulatorHandlers(
	getMainWindow: () => BrowserWindow | null,
): void {
	// Detect project type
	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_DETECT,
		async (_event, { projectDir }: { projectDir: string }) => {
			try {
				const config = await appEmulatorService.detectProject(projectDir);
				return { success: true, data: config };
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);

	// Start dev server — mutex prevents concurrent starts if renderer sends multiple requests
	let startLock = false;
	ipcMain.handle(
		IPC_CHANNELS.APP_EMULATOR_START,
		async (_event, { config }: { config: AppEmulatorConfig }) => {
			if (startLock) {
				return {
					success: false,
					error: "Already starting — ignoring duplicate request",
				};
			}
			startLock = true;
			try {
				await appEmulatorService.startServer(config);
				return { success: true };
			} catch (error: unknown) {
				return {
					success: false,
					error: error instanceof Error ? error.message : String(error),
				};
			} finally {
				startLock = false;
			}
		},
	);

	// Stop dev server — also releases startLock so server can be restarted immediately
	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_STOP, async () => {
		startLock = false;
		appEmulatorService.stopServer();
		return { success: true };
	});

	// Get current status
	ipcMain.handle(IPC_CHANNELS.APP_EMULATOR_STATUS, async () => {
		return {
			success: true,
			data: {
				running: appEmulatorService.isRunning(),
				url: appEmulatorService.getUrl(),
				config: appEmulatorService.getConfig(),
			},
		};
	});

	// Forward service events to renderer
	const sendToRenderer = (channel: string, ...args: unknown[]) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, ...args);
		}
	};

	appEmulatorService.on("status", (status: string) => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_STATUS_UPDATE, status);
	});

	appEmulatorService.on("ready", (url: string) => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_READY, url);
	});

	appEmulatorService.on("output", (line: string) => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_OUTPUT, line);
	});

	appEmulatorService.on("error", (error: string) => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_ERROR, error);
	});

	appEmulatorService.on("stopped", () => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_STOPPED);
	});

	appEmulatorService.on("config", (config: AppEmulatorConfig) => {
		sendToRenderer(IPC_CHANNELS.APP_EMULATOR_CONFIG, config);
	});
}

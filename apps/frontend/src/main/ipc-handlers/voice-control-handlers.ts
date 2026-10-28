import { ipcMain } from "electron";
import type { VoiceControlRequest } from "../voice-control-service";
import { voiceControlService } from "../voice-control-service";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/**
 * Register IPC handlers for voice control functionality
 */
export function registerVoiceControlHandlers(): void {
	// Start voice recording
	ipcMain.handle(
		IPC_CHANNELS.VOICE_CONTROL_START_RECORDING,
		async (_event, request?: VoiceControlRequest) => {
			try {
				await voiceControlService.startRecording(request);
				return { success: true };
			} catch (error) {
				console.error("[VoiceControl] Failed to start recording:", error);
				return {
					success: false,
					error: error instanceof Error ? error.message : "Unknown error",
				};
			}
		},
	);

	// Stop voice recording
	ipcMain.handle(IPC_CHANNELS.VOICE_CONTROL_STOP_RECORDING, async () => {
		try {
			voiceControlService.stopRecording();
			return { success: true };
		} catch (error) {
			console.error("[VoiceControl] Failed to stop recording:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	// Cancel voice control
	ipcMain.handle(IPC_CHANNELS.VOICE_CONTROL_CANCEL, async () => {
		try {
			const cancelled = voiceControlService.cancel();
			return { success: true, cancelled };
		} catch (error) {
			console.error("[VoiceControl] Failed to cancel:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

	// Check if voice control is active
	ipcMain.handle(IPC_CHANNELS.VOICE_CONTROL_IS_ACTIVE, async () => {
		try {
			const isActive = voiceControlService.isActive();
			return { success: true, isActive };
		} catch (error) {
			console.error("[VoiceControl] Failed to check status:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
}

/**
 * Setup event forwarding from voice control service to renderer
 */
export function setupVoiceControlEvents(): void {
	// Forward status updates
	voiceControlService.on("status", (status: string) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_STATUS, status);
			}
		});
	});

	// Forward streaming chunks
	voiceControlService.on("stream-chunk", (chunk: string) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_STREAM_CHUNK, chunk);
			}
		});
	});

	// Forward errors
	voiceControlService.on("error", (error: string) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_ERROR, error);
			}
		});
	});

	// Forward completion results
	// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
	voiceControlService.on("complete", (result: any) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_COMPLETE, result);
			}
		});
	});

	// Forward audio level updates
	voiceControlService.on("audio-level", (level: number) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_AUDIO_LEVEL, level);
			}
		});
	});

	// Forward duration updates
	voiceControlService.on("duration", (duration: number) => {
		const windows = require("electron").BrowserWindow.getAllWindows();
		// biome-ignore lint/suspicious/noExplicitAny: TODO: type this properly
		windows.forEach((window: any) => {
			if (!window.isDestroyed()) {
				window.webContents.send(IPC_CHANNELS.VOICE_CONTROL_DURATION, duration);
			}
		});
	});
}

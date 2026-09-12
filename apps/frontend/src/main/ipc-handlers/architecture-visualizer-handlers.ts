import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ipcMain } from "electron";
import {
	type ArchitectureDeltaRequest,
	type ArchitectureDeltaStatus,
	type ArchitectureMapRequest,
	architectureVisualizerService,
} from "../architecture-visualizer-service";
import { IPC_CHANNELS } from "../../shared/constants";

/**
 * Artefacts are 0.8–2.2 MB of self-contained HTML, so the renderer gets a URL
 * for a <webview> rather than the bytes. The stat here only proves the file is
 * still there and bounds its size: a stale record pointing at a deleted
 * artifact must say so rather than render an empty frame.
 */
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;

function failure(error: unknown): { success: false; error: string } {
	return {
		success: false,
		error: error instanceof Error ? error.message : "Unknown error",
	};
}

export function registerArchitectureVisualizerHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_VISUALIZER_GENERATE,
		async (_event, request: ArchitectureMapRequest) => {
			try {
				await architectureVisualizerService.map(request);
				return { success: true };
			} catch (error) {
				console.error("[ArchViz] Map error:", error);
				return failure(error);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_VISUALIZER_DOCTOR,
		async (_event, projectDir: string) => {
			try {
				return { success: true, data: await architectureVisualizerService.doctor(projectDir) };
			} catch (error) {
				return failure(error);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_DELTA_READ,
		async (_event, specDir: string) => {
			try {
				const raw = await readFile(
					path.join(specDir, "architecture", "delta.status.json"),
					"utf-8",
				);
				return {
					success: true,
					data: JSON.parse(raw) as ArchitectureDeltaStatus,
				};
			} catch (error) {
				// A task that was never mapped has no record, and that is the
				// common case rather than a failure: the tab renders nothing.
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
					return { success: true, data: null };
				}
				return failure(error);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_DELTA_REGENERATE,
		async (_event, request: ArchitectureDeltaRequest) => {
			try {
				await architectureVisualizerService.delta(request);
				return { success: true };
			} catch (error) {
				console.error("[ArchViz] Delta error:", error);
				return failure(error);
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_ARTIFACT_READ,
		async (_event, artifactPath: string) => {
			try {
				const { size } = await stat(artifactPath);
				if (size > MAX_ARTIFACT_BYTES) {
					return {
						success: false,
						error: `artifact is ${Math.round(size / 1024 / 1024)} MB, refusing to load`,
					};
				}
				return {
					success: true,
					data: { url: pathToFileURL(artifactPath).toString() },
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
					return { success: false, error: "the artifact is no longer on disk" };
				}
				return failure(error);
			}
		},
	);

	ipcMain.handle(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_CANCEL, async () => {
		try {
			return { success: true, cancelled: architectureVisualizerService.cancel() };
		} catch (error) {
			return failure(error);
		}
	});

	ipcMain.handle(
		IPC_CHANNELS.ARCHITECTURE_VISUALIZER_CONFIGURE,
		async (
			_event,
			config: { pythonPath?: string; autoBuildSourcePath?: string },
		) => {
			try {
				architectureVisualizerService.configure(
					config.pythonPath,
					config.autoBuildSourcePath,
				);
				return { success: true };
			} catch (error) {
				return failure(error);
			}
		},
	);
}

/**
 * Forward the service's events to the renderer.
 *
 * Every channel goes through `IPC_CHANNELS`. The literals this used to send
 * were how `stream-chunk` was emitted while `streamChunk` was listened for,
 * with nothing to catch the mismatch: the preload and the constants agreed
 * with each other and only the emitter disagreed with both.
 */
export function setupArchitectureVisualizerEventForwarding(): void {
	const send = (channel: string, payload: unknown): void => {
		const mainWindow = global.mainWindow;
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(channel, payload);
		}
	};

	architectureVisualizerService.on("status", (status: string) =>
		send(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_STATUS, status),
	);
	architectureVisualizerService.on("stream-chunk", (chunk: string) =>
		send(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_STREAM_CHUNK, chunk),
	);
	architectureVisualizerService.on("error", (error: string) =>
		send(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_ERROR, error),
	);
	architectureVisualizerService.on("complete", (result) =>
		send(IPC_CHANNELS.ARCHITECTURE_VISUALIZER_COMPLETE, result),
	);
	architectureVisualizerService.on("delta-status", (status) =>
		send(IPC_CHANNELS.ARCHITECTURE_DELTA_STATUS, status),
	);
}

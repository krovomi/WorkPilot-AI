import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { app, ipcMain, type BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type { DictationResult } from "../../shared/types/dictation";

/** One owner and one pending chunk. No audio is written to disk. */
export function registerDictationHandlers(
	getPython: () => string | null,
	getBackend: () => string | null,
	getWindow: () => BrowserWindow | null,
) {
	let active:
		| {
				id: string;
				owner: number;
				child: ChildProcessWithoutNullStreams;
				pending?: (value: DictationResult) => void;
				timer?: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	const cancel = () => {
		const previous = active;
		active = undefined;
		if (!previous) return;
		clearTimeout(previous.timer);
		previous.pending?.({ error: "cancelled" });
		previous.child.kill();
	};
	const wait = (timeout: number): Promise<DictationResult> =>
		new Promise((resolve) => {
			if (!active || active.pending) {
				resolve({ error: "busy" });
				return;
			}
			active.pending = resolve;
			active.timer = setTimeout(() => {
				active?.pending?.({ error: "timeout" });
				cancel();
			}, timeout);
		});
	const trusted = (event: Electron.IpcMainInvokeEvent) =>
		event.sender === getWindow()?.webContents &&
		event.senderFrame === event.sender.mainFrame;
	ipcMain.handle(
		IPC_CHANNELS.DICTATION_START,
		async (event, id: string, download: boolean, projectPath?: string) => {
			if (!trusted(event)) return { error: "permission" };
			if (active) return { error: "busy" };
			if (
				typeof id !== "string" ||
				id.length > 80 ||
				typeof download !== "boolean" ||
				(projectPath !== undefined && typeof projectPath !== "string")
			)
				return { error: "request" };
			const python = getPython();
			const backend = getBackend();
			if (!python || !backend) return { error: "dependency" };
			const args = [
				"-u",
				path.join(backend, "runners", "dictation_runner.py"),
				"--cache",
				path.join(app.getPath("userData"), "speech-models"),
			];
			if (download) args.push("--download");
			if (projectPath) args.push("--project", projectPath);
			const child = spawn(python, args, {
				windowsHide: true,
				stdio: "pipe",
				env: {
					...process.env,
					PYTHONIOENCODING: "utf-8",
					HF_HUB_DISABLE_TELEMETRY: "1",
					...(download
						? {}
						: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }),
				},
			});
			active = { id, owner: event.sender.id, child };
			const ready = wait(download ? 900_000 : 120_000);
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				if (active?.child !== child) return;
				try {
					const result = JSON.parse(line) as DictationResult;
					clearTimeout(active.timer);
					const resolve = active.pending;
					active.pending = undefined;
					resolve?.(result);
					if (result.error || download) cancel();
				} catch {
					active?.pending?.({ error: "transcription" });
					cancel();
				}
			});
			// Drain diagnostics without retaining potentially sensitive output.
			child.stderr.resume();
			child.stdin.on("error", () => {
				if (active?.child === child) cancel();
			});
			child.on("error", () => {
				if (active?.child === child) {
					active.pending?.({ error: "dependency" });
					cancel();
				}
			});
			child.on("close", () => {
				lines.close();
				if (active?.child === child) {
					active.pending?.({ error: "transcription" });
					cancel();
				}
			});
			const ownerGone = () => {
				if (active?.child === child) cancel();
			};
			event.sender.once("destroyed", ownerGone);
			event.sender.once("render-process-gone", ownerGone);
			child.once("close", () => {
				event.sender.removeListener("destroyed", ownerGone);
				event.sender.removeListener("render-process-gone", ownerGone);
			});
			return ready;
		},
	);
	ipcMain.handle(
		IPC_CHANNELS.DICTATION_TRANSCRIBE,
		(event, id: string, audio: ArrayBuffer, language: string) => {
			if (
				!trusted(event) ||
				active?.owner !== event.sender.id ||
				active?.id !== id
			)
				return { error: "cancelled" };
			if (
				!(audio instanceof ArrayBuffer) ||
				audio.byteLength > 8_000_000 ||
				typeof language !== "string" ||
				!/^(auto|fr|en|es|de|it|pt|nl|pl|ja|zh|ar|uk)(-[A-Z]{2})?$/.test(
					language,
				)
			)
				return { error: "request" };
			if (active.pending) return { error: "busy" };
			const result = wait(120_000);
			active.child.stdin.write(
				`${JSON.stringify({ audio: Buffer.from(audio).toString("base64"), language })}\n`,
			);
			return result;
		},
	);
	ipcMain.handle(IPC_CHANNELS.DICTATION_CANCEL, (event, id: string) => {
		if (trusted(event) && active?.owner === event.sender.id && active.id === id)
			cancel();
	});
	app.on("before-quit", cancel);
}

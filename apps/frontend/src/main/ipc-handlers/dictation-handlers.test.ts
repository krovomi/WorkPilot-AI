import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDictationHandlers } from "./dictation-handlers";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

const mocks = vi.hoisted(() => ({
	handle: vi.fn(),
	spawn: vi.fn(),
	on: vi.fn(),
}));
vi.mock("electron", () => ({
	ipcMain: { handle: mocks.handle },
	app: { on: mocks.on, getPath: () => "C:/test" },
}));
vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
	default: { spawn: mocks.spawn },
}));

describe("dictation IPC ownership and lifecycle", () => {
	let child: EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		stdin: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	let owner: EventEmitter & { id: number; mainFrame: object };
	let handlers: Map<string, (...args: unknown[]) => unknown>;
	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		mocks.handle.mockImplementation((name, callback) =>
			handlers.set(name, callback),
		);
		child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			stdin: new PassThrough(),
			kill: vi.fn(),
		});
		owner = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} });
		mocks.spawn.mockReturnValue(child);
		registerDictationHandlers(
			() => "python",
			() => "backend",
			() => ({ webContents: owner }) as never,
		);
	});
	const event = () => ({ sender: owner, senderFrame: owner.mainFrame });
	it("refuses previews and subframes before spawning", async () => {
		expect(
			await handlers.get(IPC_CHANNELS.DICTATION_START)?.(
				{ sender: {}, senderFrame: {} },
				"s",
				false,
			),
		).toEqual({ error: "permission" });
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
	it("uses offline mode, serializes chunks, and resolves pending work on cancellation", async () => {
		const ready = handlers.get(IPC_CHANNELS.DICTATION_START)?.(
			event(),
			"s",
			false,
		);
		child.stdout.write('{"ready":true}\n');
		expect(await ready).toEqual({ ready: true });
		expect(mocks.spawn.mock.calls[0][2].env.HF_HUB_OFFLINE).toBe("1");
		const result = handlers.get(IPC_CHANNELS.DICTATION_TRANSCRIBE)?.(
			event(),
			"s",
			new ArrayBuffer(44),
			"fr-CA",
		);
		expect(
			handlers.get(IPC_CHANNELS.DICTATION_TRANSCRIBE)?.(
				event(),
				"s",
				new ArrayBuffer(44),
				"de-DE",
			),
		).toEqual({ error: "busy" });
		handlers.get(IPC_CHANNELS.DICTATION_CANCEL)?.(event(), "s");
		expect(await result).toEqual({ error: "cancelled" });
		expect(child.kill).toHaveBeenCalledOnce();
	});
	it("rejects invalid audio and cleans up when the owning renderer exits", async () => {
		const ready = handlers.get(IPC_CHANNELS.DICTATION_START)?.(
			event(),
			"s",
			false,
		);
		child.stdout.write('{"ready":true}\n');
		await ready;
		expect(
			handlers.get(IPC_CHANNELS.DICTATION_TRANSCRIBE)?.(
				event(),
				"s",
				new ArrayBuffer(8_000_001),
				"fr",
			),
		).toEqual({ error: "request" });
		owner.emit("destroyed");
		expect(child.kill).toHaveBeenCalledOnce();
	});
});

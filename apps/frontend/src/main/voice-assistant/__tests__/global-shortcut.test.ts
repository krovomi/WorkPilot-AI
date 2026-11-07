import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ globalShortcut: { register: vi.fn(), unregister: vi.fn() } }));
vi.mock("../../settings-utils", () => ({ readSettingsFile: () => ({}) }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import {
	applyVoiceGlobalShortcut,
	getVoiceGlobalShortcutState,
	resetVoiceGlobalShortcutForTests,
	type ShortcutRegistry,
} from "../global-shortcut";

function fakeWindow() {
	return {
		isDestroyed: () => false,
		isMinimized: () => true,
		restore: vi.fn(),
		show: vi.fn(),
		focus: vi.fn(),
		webContents: { send: vi.fn() },
	};
}

describe("applyVoiceGlobalShortcut", () => {
	let registry: ShortcutRegistry & { callbacks: Map<string, () => void> };
	beforeEach(() => {
		resetVoiceGlobalShortcutForTests();
		const callbacks = new Map<string, () => void>();
		registry = {
			callbacks,
			register: vi.fn((accelerator: string, callback: () => void) => {
				callbacks.set(accelerator, callback);
				return true;
			}),
			unregister: vi.fn((accelerator: string) => {
				callbacks.delete(accelerator);
			}),
		};
	});

	it("registers nothing while the switch is off (the default)", () => {
		expect(applyVoiceGlobalShortcut({}, () => null, () => registry)).toBe("off");
		expect(registry.register).not.toHaveBeenCalled();
	});

	it("registers the default and opens the assistant from the background", () => {
		const window = fakeWindow();
		const state = applyVoiceGlobalShortcut(
			{ voiceAssistantSystemWide: true },
			() => window as never,
			() => registry,
		);
		expect(state).toBe("registered");
		registry.callbacks.get("CommandOrControl+Shift+Space")?.();
		expect(window.restore).toHaveBeenCalled();
		expect(window.focus).toHaveBeenCalled();
		expect(window.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.VOICE_ASSISTANT_TOGGLE);
	});

	it("moves the registration when the shortcut changes, and drops it when switched off", () => {
		applyVoiceGlobalShortcut({ voiceAssistantSystemWide: true }, () => null, () => registry);
		applyVoiceGlobalShortcut(
			{ voiceAssistantSystemWide: true, voiceAssistantShortcut: "Alt+Shift+V" },
			() => null,
			() => registry,
		);
		expect(registry.unregister).toHaveBeenCalledWith("CommandOrControl+Shift+Space");
		expect([...registry.callbacks.keys()]).toEqual(["Alt+Shift+V"]);
		applyVoiceGlobalShortcut({ voiceAssistantSystemWide: false }, () => null, () => registry);
		expect(registry.callbacks.size).toBe(0);
		expect(getVoiceGlobalShortcutState()).toBe("off");
	});

	it("never registers a shortcut the app already uses", () => {
		expect(
			applyVoiceGlobalShortcut(
				{ voiceAssistantSystemWide: true, voiceAssistantShortcut: "CommandOrControl+K" },
				() => null,
				() => registry,
			),
		).toBe("off");
		expect(registry.register).not.toHaveBeenCalled();
	});

	it("reports a refusal by the OS, including a throw", () => {
		registry.register = vi.fn(() => false);
		expect(applyVoiceGlobalShortcut({ voiceAssistantSystemWide: true }, () => null, () => registry)).toBe("refused");
		resetVoiceGlobalShortcutForTests();
		registry.register = vi.fn(() => {
			throw new Error("bad accelerator");
		});
		expect(applyVoiceGlobalShortcut({ voiceAssistantSystemWide: true }, () => null, () => registry)).toBe("refused");
	});
});

import { describe, expect, it } from "vitest";
import { DEFAULT_WAKE_PHRASE, MAX_WAKE_PHRASE, readWakePhrase, wakePhrase } from "../voice-wake";

describe("the wake phrase setting", () => {
	it("falls back to « Hey WorkPilot » when missing, too long or too short", () => {
		expect(wakePhrase(undefined)).toBe(DEFAULT_WAKE_PHRASE);
		expect(wakePhrase(42)).toBe(DEFAULT_WAKE_PHRASE);
		expect(wakePhrase("x".repeat(MAX_WAKE_PHRASE + 1))).toBe(DEFAULT_WAKE_PHRASE);
		expect(wakePhrase(" ?! ")).toBe(DEFAULT_WAKE_PHRASE);
		expect(wakePhrase("  Hey   Otto ")).toBe("Hey Otto");
	});
});

describe("hearing the wake phrase", () => {
	it("hears it however Whisper writes it, and keeps what was said after", () => {
		expect(readWakePhrase("Hey, Work Pilot. Ouvre le Kanban.", "Hey WorkPilot")).toEqual({
			rest: "Ouvre le Kanban.",
		});
		expect(readWakePhrase("Hé WorkPilot !", "Hey WorkPilot")).toEqual({ rest: "" });
		expect(readWakePhrase("okay workpilot, — open settings", "Hey WorkPilot")).toEqual({
			rest: "open settings",
		});
	});

	it("takes a filler or two before it, not a whole sentence", () => {
		expect(readWakePhrase("Euh, hey WorkPilot", "Hey WorkPilot")).toEqual({ rest: "" });
		expect(readWakePhrase("bon alors hey WorkPilot", "Hey WorkPilot")).toEqual({ rest: "" });
		expect(readWakePhrase("je disais que hey WorkPilot", "Hey WorkPilot")).toBeNull();
	});

	it("drops every other sentence", () => {
		expect(readWakePhrase("Ouvre le Kanban", "Hey WorkPilot")).toBeNull();
		expect(readWakePhrase("Salut WorkPilot", "Hey WorkPilot")).toBeNull();
		expect(readWakePhrase("Hey Work", "Hey WorkPilot")).toBeNull();
		expect(readWakePhrase("Hey Workpilots", "Hey WorkPilot")).toBeNull();
		expect(readWakePhrase("", "Hey WorkPilot")).toBeNull();
	});

	it("reads a custom phrase, with or without a greeting", () => {
		expect(readWakePhrase("Otto, lance les tests", "Otto")).toEqual({ rest: "lance les tests" });
		expect(readWakePhrase("Hey", "Hey")).toEqual({ rest: "" });
		expect(readWakePhrase("Hey Otto", "Otto")).toEqual({ rest: "" });
		expect(readWakePhrase("Otto", "!!")).toBeNull();
	});
});

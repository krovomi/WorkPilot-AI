import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimMicrophoneForForm,
	holdVoiceMicrophone,
	useVoiceAssistantStore,
} from "../voice-assistant-store";

describe("voice assistant store", () => {
	beforeEach(() => {
		useVoiceAssistantStore.setState({
			isOpen: false,
			continuous: false,
			formDictations: 0,
			pairTaskId: null,
			pairNarration: "",
			pendingCommand: null,
		});
	});

	it("opens on a sentence the wake word brought, read once", () => {
		const store = useVoiceAssistantStore.getState();
		store.openWith("  ouvre le kanban ");
		expect(useVoiceAssistantStore.getState()).toMatchObject({ isOpen: true, pendingCommand: "ouvre le kanban" });
		expect(store.takePendingCommand()).toBe("ouvre le kanban");
		expect(store.takePendingCommand()).toBeNull();
		store.openWith("   ");
		expect(useVoiceAssistantStore.getState().pendingCommand).toBeNull();
		store.openWith("stop");
		store.close();
		expect(useVoiceAssistantStore.getState()).toMatchObject({ isOpen: false, pendingCommand: null });
	});

	it("follows a task, and forgets it when the continuous mode stops", () => {
		const store = useVoiceAssistantStore.getState();
		store.startContinuous();
		store.followTask("t1");
		useVoiceAssistantStore.setState({ pairNarration: "coding" });
		store.followTask("t2");
		expect(useVoiceAssistantStore.getState()).toMatchObject({ pairTaskId: "t2", pairNarration: "" });
		useVoiceAssistantStore.setState({ pairNarration: "coding" });
		store.stopContinuous();
		expect(useVoiceAssistantStore.getState()).toMatchObject({
			continuous: false,
			pairTaskId: null,
			pairNarration: "",
		});
	});

	it("lets the task form take the microphone at once, and gives it back once", () => {
		const release = vi.fn();
		const unhold = holdVoiceMicrophone(release);
		const giveBack = claimMicrophoneForForm();
		expect(release).toHaveBeenCalledOnce();
		expect(useVoiceAssistantStore.getState().formDictations).toBe(1);
		const second = claimMicrophoneForForm();
		expect(useVoiceAssistantStore.getState().formDictations).toBe(2);
		giveBack();
		giveBack();
		expect(useVoiceAssistantStore.getState().formDictations).toBe(1);
		second();
		expect(useVoiceAssistantStore.getState().formDictations).toBe(0);
		unhold();
		claimMicrophoneForForm()();
		expect(release).toHaveBeenCalledTimes(2);
		// Never below zero, even when the count was reset meanwhile.
		const late = claimMicrophoneForForm();
		useVoiceAssistantStore.setState({ formDictations: 0 });
		late();
		expect(useVoiceAssistantStore.getState().formDictations).toBe(0);
	});
});

/**
 * JEV where it acts: what it is, what it will do next, what it said last,
 * and the switch for this workflow — without a trip to Settings.
 */

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import type { JevObservation } from "../../../shared/types/jev";
import { useJevStore } from "../../stores/jev-store";
import { useSettingsStore } from "../../stores/settings-store";
import { JevStatus, jevReason } from "./JevStatus";

vi.mock("../../hooks/useAirgapStatus", () => ({
	useAirgapStatus: () => ({ airgapStrict: false, loaded: true }),
}));

function configure(configured: boolean) {
	Object.assign(window.electronAPI, {
		getJevStatus: vi.fn().mockResolvedValue({
			success: true,
			data: { configured, secureStorageAvailable: true },
		}),
		saveSettings: vi.fn().mockResolvedValue({ success: true }),
	});
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	useSettingsStore.setState((s) => ({
		settings: { ...s.settings, jev: { enabled: true } },
	}));
	useJevStore.setState({ status: null });
	configure(true);
});
afterEach(cleanup);

describe("jevReason", () => {
	const base = {
		offline: false,
		mode: "inherit" as const,
		enabledGlobally: true,
		status: { configured: true },
		policyLoaded: true,
		hasProject: false,
	};
	it("is ready when everything is in place", () => {
		expect(jevReason(base)).toBe("ready");
	});
	it("lets strict offline mode win over everything", () => {
		expect(jevReason({ ...base, offline: true, mode: "enabled" })).toBe("offline");
	});
	it("honours a per-workflow switch over the global one", () => {
		expect(jevReason({ ...base, enabledGlobally: false, mode: "enabled" })).toBe("ready");
		expect(jevReason({ ...base, mode: "bypass" })).toBe("workflow_bypass");
		expect(jevReason({ ...base, enabledGlobally: false })).toBe("disabled");
	});
	it("asks for a key when there is none", () => {
		expect(jevReason({ ...base, status: { configured: false } })).toBe("missing_key");
	});
});

it("says what JEV is and that it is ready", async () => {
	render(<JevStatus workflow="feature-build" />);
	expect(screen.getByText("JEV second opinion")).toBeInTheDocument();
	expect(await screen.findByText("ready")).toBeInTheDocument();
});

it("switches JEV off for this workflow only, from the card", async () => {
	render(<JevStatus workflow="feature-build" />);
	fireEvent.click(await screen.findByRole("button", { name: "Bypassed" }));
	await waitFor(() => expect(window.electronAPI.saveSettings).toHaveBeenCalled());
	const saved = vi.mocked(window.electronAPI.saveSettings).mock.calls[0][0];
	expect(saved.jev?.workflows?.["feature-build"]).toBe("bypass");
	expect(saved.jev?.enabled).toBe(true);
	expect(await screen.findByText("bypassed here")).toBeInTheDocument();
});

it("opens the key page when the key is missing", async () => {
	configure(false);
	const listener = vi.fn();
	globalThis.addEventListener("open-app-settings", listener);
	render(<JevStatus workflow="feature-build" />);
	fireEvent.click(await screen.findByRole("button", { name: /Add API key/ }));
	expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe("jev");
	globalThis.removeEventListener("open-app-settings", listener);
});

it("reads coverage and risk on their scale rather than as bare numbers", async () => {
	const observation: JevObservation = {
		version: 1,
		runId: "r1",
		workflow: "feature-build",
		evaluations: [
			{
				point: "planning",
				passId: "p1",
				revision: "0123456789abcdef",
				status: "evaluated",
				createdAt: "2026-09-26T10:00:00Z",
				answers: {
					task_class: { value: "bugfix", confidence: 0.92 },
					coverage: { value: 2 },
					risk: { value: 1 },
				},
			},
		],
	};
	render(<JevStatus workflow="feature-build" observation={observation} />);
	expect(await screen.findByText("bugfix")).toBeInTheDocument();
	expect(screen.getByText("good")).toBeInTheDocument();
	expect(screen.getByText("moderate")).toBeInTheDocument();
	expect(screen.getByText("(confidence: 92%)")).toBeInTheDocument();
});

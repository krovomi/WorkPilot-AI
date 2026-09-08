import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOfflineModeStore } from "../../stores/offline-mode-store";
import { OfflineModeSettings } from "./OfflineModeSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr" } }),
}));
afterEach(cleanup);
beforeEach(() => {
	useOfflineModeStore.setState({
		savedPolicy: null,
		projectPath: "project",
		status: null,
		report: null,
		loading: false,
		saving: false,
		scanning: false,
		error: null,
		dirty: true,
		loadAll: vi.fn(),
		policy: {
			version: 1,
			airgapStrict: false,
			defaultProvider: "ollama",
			history: [],
			routing: { coder: { provider: "ollama", model: "qwen2.5-coder:7b" } },
		},
		catalog: {
			providers: {
				ollama: ["qwen2.5-coder:7b"],
				"lm-studio": [],
				"llama-cpp": [],
			},
			local: { ollama: true, lmStudio: false, llamaCpp: false },
			cachedAt: "",
			ageSeconds: 0,
			ttlSeconds: 900,
			fromCache: false,
		},
	});
});

it("clears the model when switching to a runtime without models", () => {
	render(<OfflineModeSettings projectPath="project" />);
	fireEvent.change(screen.getAllByRole("combobox")[1], {
		target: { value: "lm-studio" },
	});
	expect(useOfflineModeStore.getState().policy?.routing.coder).toEqual({
		provider: "lm-studio",
		model: "",
	});
	expect(
		(
			screen.getByRole("button", {
				name: "offlineMode:save",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
});

it("shows an old cloud route as disabled and blocks saving", () => {
	const policy = useOfflineModeStore.getState().policy;
	if (!policy) throw new Error("Missing test policy");
	useOfflineModeStore.setState({
		policy: {
			...policy,
			routing: { coder: { provider: "anthropic", model: "claude" } },
		},
	});
	render(<OfflineModeSettings projectPath="project" />);
	const cloudOption = screen.getByRole("option", {
		name: /anthropic/,
	}) as HTMLOptionElement;
	expect(cloudOption.disabled).toBe(true);
	expect(screen.getByRole("alert").textContent).toBe(
		"offlineMode:invalidPolicy",
	);
	expect(
		(
			screen.getByRole("button", {
				name: "offlineMode:save",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
});

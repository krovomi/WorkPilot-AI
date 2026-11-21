/** @vitest-environment jsdom */
/**
 * What the panels share: the backend's English errors worded in the app's
 * language, the token cost under a budget, and paths shown relative to the
 * project.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../../shared/i18n";
import { useSettingsStore } from "../../../stores/settings-store";
import { ProviderContext } from "../../ProviderContext";
import { relativeToProject } from "../_relative-to-project";
import { TokenCostEstimate } from "../_token-cost-estimate";
import { translateBackendError } from "../_translate-backend-error";
import { openWorld } from "./phase35-world";

beforeEach(async () => {
	await openWorld();
	useSettingsStore.setState({
		profiles: [],
		activeProfileId: null,
		settings: { ...useSettingsStore.getState().settings, defaultModel: undefined },
	} as never);
});
afterEach(cleanup);

describe("translateBackendError", () => {
	const t = i18n.getFixedT("en", "phase35");

	it.each([
		["project_path is not a valid directory: /nope ", "Invalid project path: /nope"],
		["project_path is required", "Project path is required"],
		["folder not found: /x", "Directory not found: /x"],
		["File not found: a.txt", "File not found: a.txt"],
		["EACCES: open /etc", "Access denied. Check directory permissions."],
		["fetch failed", "Backend unreachable. Is the backend running on port 9000?"],
		["request timed out", "Timed out — the backend did not respond in time."],
		["  something odd  ", "Backend error: something odd"],
	])("words %j", (raw, shown) => {
		expect(translateBackendError(raw, t)).toBe(shown);
	});

	it("has nothing to say without an error", () => {
		expect(translateBackendError("", t)).toBeNull();
		expect(translateBackendError(null, t)).toBeNull();
	});
});

describe("relativeToProject", () => {
	it("cuts the project out of a path inside it, whatever the separators", () => {
		expect(relativeToProject("/work/shop/src/a.ts", "/work/shop/")).toBe("src/a.ts");
		expect(relativeToProject("C:\\work\\shop\\src\\a.ts", "C:\\work\\shop")).toBe("src/a.ts");
	});

	it("leaves a path outside the project, or with no project, as it is", () => {
		expect(relativeToProject("/etc/hosts", "/work/shop")).toBe("/etc/hosts");
		expect(relativeToProject("/work/shopping/a.ts", "/work/shop")).toBe("/work/shopping/a.ts");
		expect(relativeToProject("src/a.ts", "")).toBe("src/a.ts");
	});
});

function withProvider(provider: string, node: React.ReactNode) {
	return <ProviderContext.Provider value={{ selectedProvider: provider } as never}>{node}</ProviderContext.Provider>;
}

describe("TokenCostEstimate", () => {
	it("says when no model is configured", () => {
		render(withProvider("nobody", <TokenCostEstimate totalTokens={8000} />));
		expect(screen.getByText("No model configured in settings")).toBeInTheDocument();
	});

	it("says when the model has no known price rather than showing zero", () => {
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, defaultModel: "home-made-1" },
		} as never);
		render(<TokenCostEstimate totalTokens={8000} />);
		expect(screen.getByText("Pricing unknown for this model")).toBeInTheDocument();
		expect(screen.getByText("(anthropic/home-made-1)")).toBeInTheDocument();
	});

	it("says a flat-rate seat has no per-token cost", () => {
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, defaultModel: "llama3:70b" },
		} as never);
		render(withProvider("ollama", <TokenCostEstimate totalTokens={8000} />));
		expect(screen.getByText("Flat-rate seat licence — no per-token cost")).toBeInTheDocument();
		expect(screen.getByText("(ollama/llama3:70b)")).toBeInTheDocument();
	});

	it("prices the budget in dollars, with its input and output split", () => {
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, defaultModel: "claude-opus-5-5" },
		} as never);
		render(<TokenCostEstimate totalTokens={8000} outputRatio={0.5} decimals={2} />);
		expect(screen.getByText("Estimated cost:")).toBeInTheDocument();
		expect(screen.getByText("for anthropic / claude-opus-5-5")).toBeInTheDocument();
		expect(screen.getByText(/^\$\d+\.\d{2} input \+ \$\d+\.\d{2} output \(50% ratio\)$/)).toBeInTheDocument();
	});

	it("prices it in euros in French, at the fetched rate", async () => {
		await i18n.changeLanguage("fr");
		useSettingsStore.setState({
			settings: { ...useSettingsStore.getState().settings, defaultModel: "claude-opus-5-5" },
		} as never);
		const { unmount } = render(<TokenCostEstimate totalTokens={1_000_000} outputRatio={0} />);
		// $4 per million input tokens, at the 0.5 rate the test's network answers.
		expect(await screen.findByText("2.0000 €")).toBeInTheDocument();
		expect(screen.getByText("pour anthropic / claude-opus-5-5")).toBeInTheDocument();
		unmount();
	});
});

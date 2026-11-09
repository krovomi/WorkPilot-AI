/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CompletionStep } from "./CompletionStep";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options?.providers ? `${key}:${options.providers}` : key,
	}),
}));

// One state object: the real store hands back the same arrays between renders.
const storeState = { profiles: [], settings: {} };
vi.mock("../../stores/settings-store", () => ({
	useSettingsStore: vi.fn((selector) => selector(storeState)),
}));

const getStaticProviders = vi.fn();
vi.mock("../../../shared/utils/providers", () => ({
	getStaticProviders: (...args: unknown[]) => getStaticProviders(...args),
}));

const providers = [
	{ name: "anthropic", label: "Anthropic (Claude)", description: "" },
	{ name: "copilot", label: "GitHub Copilot", description: "" },
	{ name: "ollama", label: "Ollama", description: "" },
];

describe("CompletionStep", () => {
	beforeEach(() => {
		getStaticProviders.mockReset();
	});

	it("does not claim the setup is complete when no AI is connected", async () => {
		// It said « Setup Complete » even after skipping every step.
		getStaticProviders.mockResolvedValue({ providers, status: { ollama: true } });
		const onConnectProvider = vi.fn();
		render(<CompletionStep onFinish={vi.fn()} onConnectProvider={onConnectProvider} />);

		expect(await screen.findByText("completion.noProvider")).toBeInTheDocument();
		expect(screen.getByText("completion.titleNotReady")).toBeInTheDocument();
		expect(screen.queryByText("completion.setupComplete")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /completion.connectProvider/ }));
		expect(onConnectProvider).toHaveBeenCalledTimes(1);
	});

	it("names the connected providers", async () => {
		getStaticProviders.mockResolvedValue({
			providers,
			status: { anthropic: false, copilot: true },
		});
		render(<CompletionStep onFinish={vi.fn()} />);

		expect(await screen.findByText("completion.setupComplete")).toBeInTheDocument();
		expect(screen.getByText("completion.connectedTo:GitHub Copilot")).toBeInTheDocument();
		expect(screen.getByText("completion.title")).toBeInTheDocument();
	});

	it("says it is checking until the answer comes", () => {
		getStaticProviders.mockReturnValue(new Promise(() => {}));
		render(<CompletionStep onFinish={vi.fn()} />);
		expect(screen.getByText("completion.checking")).toBeInTheDocument();
		expect(screen.queryByText("completion.setupComplete")).not.toBeInTheDocument();
	});
});

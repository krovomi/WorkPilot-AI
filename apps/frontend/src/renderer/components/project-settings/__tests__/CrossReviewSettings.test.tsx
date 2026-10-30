/**
 * The cross review's engine (IA2): off by default, another provider than the
 * build's when switched on, and a warning when the person picks the same one.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "../../../../shared/types";
import { CrossReviewSettings } from "../CrossReviewSettings";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
		i18n: { language: "en" },
	}),
}));
vi.mock("../../ProviderContext", () => ({
	useProviderContext: () => ({ selectedProvider: "anthropic" }),
}));
vi.mock("../../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({
		providers: [
			{ name: "anthropic", label: "Claude" },
			{ name: "openai", label: "OpenAI" },
		],
		loading: false,
	}),
}));
vi.mock("../../task-engine/EngineTrioPicker", () => ({
	EngineTrioPicker: ({
		value,
		onChange,
	}: {
		value: { provider: string };
		onChange: (trio: unknown, reason: string) => void;
	}) => (
		<select
			aria-label="provider"
			value={value.provider}
			onChange={(e) =>
				onChange({ ...value, provider: e.target.value }, "user")
			}
		>
			<option value="anthropic">anthropic</option>
			<option value="openai">openai</option>
		</select>
	),
}));

const BASE = {
	model: "claude-opus-4-8",
	linearSync: false,
	notifications: {
		onTaskComplete: true,
		onTaskFailed: true,
		onReviewNeeded: true,
		sound: false,
	},
} as ProjectSettings;

function Harness({ initial = BASE }: { initial?: ProjectSettings }) {
	const [settings, setSettings] = useState(initial);
	return (
		<>
			<CrossReviewSettings settings={settings} setSettings={setSettings} />
			<output data-testid="saved">{JSON.stringify(settings.crossReview ?? null)}</output>
		</>
	);
}

describe("CrossReviewSettings", () => {
	it("is off by default", () => {
		render(<Harness />);
		expect(screen.getByRole("switch")).not.toBeChecked();
		expect(screen.getByTestId("saved")).toHaveTextContent("null");
	});

	it("switched on, it picks another provider than the build's", () => {
		render(<Harness />);

		fireEvent.click(screen.getByRole("switch"));

		expect(JSON.parse(screen.getByTestId("saved").textContent ?? "")).toEqual({
			provider: "openai",
			model: "",
			effort: "medium",
		});
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("warns when the second engine is the build's provider", () => {
		render(
			<Harness
				initial={{
					...BASE,
					crossReview: { provider: "openai", model: "gpt-5.5", effort: "high" },
				}}
			/>,
		);

		fireEvent.change(screen.getByLabelText("provider"), {
			target: { value: "anthropic" },
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"projectSections.general.crossReviewSameProvider",
		);
	});

	it("switched off, it forgets the engine", () => {
		render(
			<Harness
				initial={{
					...BASE,
					crossReview: { provider: "openai", model: "gpt-5.5", effort: "high" },
				}}
			/>,
		);

		fireEvent.click(screen.getByRole("switch"));

		expect(screen.getByTestId("saved")).toHaveTextContent("null");
	});
});

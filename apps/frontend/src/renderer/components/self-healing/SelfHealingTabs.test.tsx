/**
 * @vitest-environment jsdom
 */
/**
 * What each tab adds for #370, #372 and #375: the CI/CD tab's bisect switch
 * and panel, the production tab's clusters and groups, the proactive tab's
 * trends.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Incident } from "../../../shared/types/self-healing";
import { useSelfHealingStore } from "../../stores/self-healing-store";
import { CICDTab } from "./CICDTab";
import { ProactiveTab } from "./ProactiveTab";
import { ProductionTab } from "./ProductionTab";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const setCICDConfig = vi.fn();

function incident(mode: Incident["mode"], source_data: Record<string, unknown> = {}): Incident {
	return {
		id: `${mode}-1`,
		mode,
		source: "git_push",
		severity: "medium",
		title: "Broken",
		description: "",
		status: "pending",
		created_at: "2026-10-10T00:00:00",
		source_data,
		affected_files: [],
	};
}

beforeEach(() => {
	setCICDConfig.mockReset();
	useSelfHealingStore.setState({
		incidents: [incident("cicd"), incident("production", { fingerprint: "ab12" })],
		activeOperations: [],
		bisects: {},
		incidentClusters: [],
		riskTrends: null,
		setCICDConfig,
	});
});

function autoBisect(): HTMLInputElement {
	return screen.getByText("selfHealing:autoBisect").querySelector("input") as HTMLInputElement;
}

describe("CICDTab", () => {
	it("bisects by default and can be told not to", () => {
		const config = useSelfHealingStore.getState().cicdConfig;
		useSelfHealingStore.setState({ cicdConfig: { ...config, autoBisect: undefined } });
		const { rerender } = render(<CICDTab projectPath="/proj" />);
		expect(autoBisect()).toBeChecked();
		fireEvent.click(autoBisect());
		expect(setCICDConfig).toHaveBeenCalledWith("/proj", { autoBisect: false });
		expect(screen.getByTestId("bisect-panel")).toBeInTheDocument();

		useSelfHealingStore.setState({ cicdConfig: { ...config, autoBisect: false } });
		rerender(<CICDTab projectPath="/proj" />);
		expect(autoBisect()).not.toBeChecked();
	});
});

describe("ProductionTab", () => {
	it("shows each incident's group", () => {
		render(<ProductionTab projectPath="/proj" />);
		expect(screen.getByTestId("incident-group")).toHaveTextContent("ab12");
	});
});

describe("ProactiveTab", () => {
	it("shows the trends before the fragility chart", () => {
		render(<ProactiveTab projectPath="/proj" />);
		expect(screen.getByTestId("trends-empty")).toBeInTheDocument();
	});
});

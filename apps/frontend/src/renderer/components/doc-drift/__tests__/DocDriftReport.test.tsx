/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts && typeof opts === "object" && "count" in opts ? `${key}:${String(opts.count)}` : key,
		i18n: { language: "en" },
	}),
}));
vi.mock("../../../hooks/useSharedAnalysisReport", () => ({ useSharedAnalysisReport: () => null }));

import type { DriftReport } from "../../../../shared/types/doc-drift";
import { useDocDriftStore } from "../../../stores/doc-drift-store";
import { DocDriftReport } from "../DocDriftReport";

const report: DriftReport = {
	docsScanned: 2,
	codeFilesIndexed: 5,
	symbolsIndexed: 24,
	languages: [{ label: "C# / .NET", files: 2 }],
	issues: [
		{
			driftType: "missing_function",
			severity: "high",
			docFile: "README.md",
			docLine: 3,
			referencedSymbol: "OrderService.PlaceOrder",
			message: "m",
			suggestion: "s",
		},
		{
			driftType: "stale_reference",
			severity: "medium",
			docFile: "docs/a.md",
			docLine: 5,
			referencedSymbol: "docs/deploy.md",
			message: "m",
			suggestion: "s",
		},
	],
	summary: "",
};

describe("DocDriftReport", () => {
	beforeEach(() => {
		useDocDriftStore.getState().reset();
	});

	it("before any scan, every column says what will appear and the scan is the primary action", () => {
		render(<DocDriftReport projectPath="/p" />);
		expect(screen.getByText("issues.emptyTitle")).toBeInTheDocument();
		expect(screen.getByText("detail.emptyTitle")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "actions.runScan" })).toHaveClass("wp-btn-primary");
	});

	it("filters gaps by severity and shows the selected one", () => {
		useDocDriftStore.getState().setReport(report);
		render(<DocDriftReport projectPath="/p" />);
		expect(screen.getByText("OrderService.PlaceOrder")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /^medium · 1$/ }));
		expect(screen.queryByText("OrderService.PlaceOrder")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /docs\/deploy\.md/ }));
		expect(screen.getByText("docs/a.md:5", { selector: "p" })).toBeInTheDocument();
		expect(screen.getByText("types.stale_reference.fix")).toBeInTheDocument();
	});

	it("shows the cause of a failed scan without the IPC prefix", () => {
		useDocDriftStore.setState({
			phase: "error",
			error: "Error invoking remote method 'docDrift:run': Error: Python environment not ready: no venv",
		});
		render(<DocDriftReport projectPath="/p" />);
		expect(screen.getByRole("alert")).toHaveTextContent("errors.failed");
	});
});

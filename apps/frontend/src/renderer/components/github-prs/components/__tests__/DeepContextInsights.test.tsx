/**
 * What the review learnt about the codebase before reading the PR: its
 * architecture, rules broken, patterns, related code and past trouble.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../../../shared/i18n";
import { DeepContextInsights } from "../DeepContextInsights";

type Context = React.ComponentProps<typeof DeepContextInsights>["deepContext"];

const EMPTY: Context = {
	projectPatterns: {},
	projectConventions: [],
	relatedCode: [],
	historicalInsights: [],
	pastBugsInArea: [],
	regressionRisks: [],
	architectureStyle: "",
	architectureLayers: [],
	architectureViolations: [],
	gatheringDurationMs: 420,
	contextAvailable: true,
};

const FULL: Context = {
	...EMPTY,
	architectureStyle: "Clean Architecture",
	architectureLayers: [
		{ name: "domain", patterns: ["src/domain/**"], allowedImports: [] },
		{ name: "api", patterns: ["src/api/**", "src/web/**"], allowedImports: ["domain"] },
	],
	architectureViolations: [
		{ type: "layer_violation", severity: "error", file: "src/domain/user.ts", description: "imports the API", suggestion: "Invert the dependency" },
		{ type: "layer_violation", severity: "warning", file: "src/domain/user.ts", description: "imports the web layer" },
		{ type: "bounded_context", severity: "critical-ish", file: "src/b.ts", description: "crosses a context" },
	],
	projectPatterns: { errors: "x".repeat(250), naming: "camelCase" },
	projectConventions: ["Use Result types", "Use Result types", "No default exports"],
	relatedCode: [
		{ path: "src/api/users.ts", reason: "calls it" },
		{ path: "src/api/users.ts", reason: "tests it" },
	],
	historicalInsights: [{ fact: "Retries were removed once" }, { content: "Slow in CI" }, { other: 1 }],
	pastBugsInArea: [{ description: "Null user crash" }, { fact: "Race on save" }, { id: 9 }],
	regressionRisks: ["Login flow", "Login flow"],
};

async function open(context: Context) {
	render(<DeepContextInsights deepContext={context} />);
	await userEvent.click(screen.getByRole("button", { name: /Deep Codebase Context/ }));
}

describe("DeepContextInsights", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("shows nothing without context, or with context that holds nothing", () => {
		const { container, rerender } = render(
			<DeepContextInsights deepContext={{ ...FULL, contextAvailable: false }} />,
		);
		expect(container).toBeEmptyDOMElement();
		rerender(<DeepContextInsights deepContext={EMPTY} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("counts its sections and how long gathering took, folded at first", () => {
		render(<DeepContextInsights deepContext={FULL} />);
		expect(screen.getByText("5 sections")).toBeInTheDocument();
		expect(screen.getByText("Context gathered in 420ms")).toBeInTheDocument();
		expect(screen.queryByText("Clean Architecture")).toBeNull();
	});

	it("opens from the keyboard", async () => {
		render(<DeepContextInsights deepContext={FULL} />);
		const header = screen.getByRole("button", { name: /Deep Codebase Context/ });
		expect(header).toHaveAttribute("aria-expanded", "false");
		header.focus();
		await userEvent.keyboard("{Enter}");
		expect(header).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Clean Architecture")).toBeInTheDocument();
	});

	it("shows the architecture and its layers", async () => {
		await open(FULL);
		expect(screen.getByText("Clean Architecture")).toBeInTheDocument();
		expect(screen.getByText("(src/api/**, src/web/**)")).toBeInTheDocument();
		expect(screen.getByText("Can import from: domain")).toBeInTheDocument();
		expect(screen.getAllByText(/Can import from/)).toHaveLength(1);
	});

	it("keeps every rule broken, even two in one file, in the app's language", async () => {
		await i18n.changeLanguage("fr");
		render(<DeepContextInsights deepContext={FULL} />);
		await userEvent.click(screen.getByRole("button", { name: /Contexte profond/ }));
		expect(screen.getByText("imports the API")).toBeInTheDocument();
		expect(screen.getByText("imports the web layer")).toBeInTheDocument();
		expect(screen.getByText("Invert the dependency")).toBeInTheDocument();
		expect(screen.getByText("Erreur")).toBeInTheDocument();
		expect(screen.getByText("Avertissement")).toBeInTheDocument();
		// A severity the app does not know stays as sent.
		expect(screen.getByText("critical-ish")).toBeInTheDocument();
	});

	it("shows patterns cut short, conventions, and every related file", async () => {
		await open(FULL);
		expect(screen.getByText(`${"x".repeat(200)}...`)).toBeInTheDocument();
		expect(screen.getByText("camelCase")).toBeInTheDocument();
		expect(screen.getAllByText("Use Result types")).toHaveLength(2);
		expect(screen.getByText("calls it")).toBeInTheDocument();
		expect(screen.getByText("tests it")).toBeInTheDocument();
	});

	it("tells what happened here before", async () => {
		await open(FULL);
		for (const text of ["Retries were removed once", "Slow in CI", '{"other":1}', "Null user crash", "Race on save", '{"id":9}']) {
			expect(screen.getByText(text)).toBeInTheDocument();
		}
		expect(screen.getAllByText("Login flow")).toHaveLength(2);
	});

	it("shows a section alone when the others are empty", async () => {
		await open({ ...EMPTY, architectureLayers: FULL.architectureLayers, projectConventions: ["Tabs"], regressionRisks: ["Export"] });
		expect(screen.getByText("Domain".toLowerCase())).toBeInTheDocument();
		expect(screen.getByText("Tabs")).toBeInTheDocument();
		expect(screen.getByText("Export")).toBeInTheDocument();
		expect(screen.queryByText(/Architecture Style/)).toBeNull();
		expect(screen.queryByText(/Past Bugs/)).toBeNull();
	});

	it("shows patterns without conventions, and past bugs alone", async () => {
		await open({ ...EMPTY, projectPatterns: { naming: "camelCase" }, pastBugsInArea: [{ description: "Crash" }], architectureStyle: "Hexagonal" });
		expect(screen.getByText("camelCase")).toBeInTheDocument();
		expect(screen.getByText("Crash")).toBeInTheDocument();
		expect(screen.getByText("Hexagonal")).toBeInTheDocument();
		expect(screen.queryByText(/Layers/)).toBeNull();
		expect(screen.queryByText(/Conventions/)).toBeNull();
	});
});

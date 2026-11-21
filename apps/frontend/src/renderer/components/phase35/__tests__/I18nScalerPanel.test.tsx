/** @vitest-environment jsdom */
/**
 * The translation report of a folder, and the editor of its JSON catalogs.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useI18nEditorStore } from "../../../stores/i18n-editor-store";
import { I18nScalerPanel } from "../I18nScalerPanel";
import { type Api, openWorld } from "./phase35-world";

let api: Api;
beforeEach(async () => {
	api = await openWorld({ selectDirectory: async () => "/work/shop/locales" });
});
afterEach(cleanup);

const REPORT = {
	source_locale: "en",
	coverage: [{ locale: "fr", total_keys: 10, translated_keys: 8, placeholder_keys: 1, coverage_ratio: 0.8 }],
	diffs: [
		{
			source_locale: "en",
			target_locale: "fr",
			missing_keys: ["a.b"],
			obsolete_keys: ["old.key"],
			placeholder_mismatches: ["count.items"],
			totals: { missing: 1, obsolete: 1, placeholder_mismatches: 1 },
		},
	],
};

describe("I18nScalerPanel, report", () => {
	it("asks for a folder, picks it in a dialog, and reports on it", async () => {
		api.reportI18nFromDir.mockResolvedValue({
			success: true,
			report: REPORT,
			locales_dir: "/work/shop/locales",
			layout: "nested",
		});
		render(<I18nScalerPanel />);
		expect(screen.getByText("Enter the locales directory")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Run report" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
		await waitFor(() => expect(screen.getByLabelText("Locales directory")).toHaveValue("/work/shop/locales"));
		fireEvent.change(screen.getByLabelText("Source locale"), { target: { value: "fr" } });
		fireEvent.click(screen.getByRole("button", { name: "Run report" }));
		expect(await screen.findByText("Coverage per locale")).toBeInTheDocument();
		expect(api.reportI18nFromDir).toHaveBeenCalledWith("/work/shop/locales", "fr");
		expect(screen.getByText("Read from /work/shop/locales")).toBeInTheDocument();
		expect(screen.getByText("80.0%")).toBeInTheDocument();
		expect(screen.getByText(/fr \(1 missing,\s*1 obsolete,\s*1 mismatches\)/)).toBeInTheDocument();
		expect(screen.getByText("a.b")).toBeInTheDocument();
		expect(screen.getByText("old.key")).toBeInTheDocument();
		expect(screen.getByText("count.items")).toBeInTheDocument();
		expect(screen.queryByText(/Catalogs read/)).not.toBeInTheDocument();
	});

	it("says when the picked folder was one locale, and names other stacks' catalogs", async () => {
		api.reportI18nFromDir.mockResolvedValue({
			success: true,
			report: REPORT,
			locales_dir: "/work/shop",
			redirected_from: "/work/shop/fr",
			layout: "catalogs",
			formats: ["resx", "brand_new"],
		});
		render(<I18nScalerPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Analyse the whole open project" }));
		expect(screen.queryByRole("button", { name: "Analyse the whole open project" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Run report" }));
		expect(
			await screen.findByText("/work/shop/fr is one locale, not the locales root — read /work/shop instead."),
		).toBeInTheDocument();
		expect(screen.getByText(/Catalogs read: RESX \(\.NET\), brand_new\./)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		expect(screen.getByLabelText("Locales directory")).toHaveValue("");
	});

	it("keeps the folder when the dialog is dismissed, and says when it fails", async () => {
		api.selectDirectory.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("no window"));
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
		await waitFor(() => expect(api.selectDirectory).toHaveBeenCalledTimes(1));
		expect(screen.getByLabelText("Locales directory")).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The file dialog could not open.");
	});

	it("refuses a folder path longer than the backend reads", async () => {
		api.selectDirectory.mockResolvedValue(`/${"x".repeat(1100)}`);
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
		expect(await screen.findByText("Text too long (limit: 1024 characters)")).toBeInTheDocument();
	});

	it("takes a custom source locale, checks it, and goes back to the list", async () => {
		render(<I18nScalerPanel />);
		fireEvent.change(screen.getByLabelText("Source locale"), { target: { value: "__custom__" } });
		const custom = screen.getByLabelText("Custom locale code");
		expect(screen.getByText("Enter the source locale")).toBeInTheDocument();
		fireEvent.change(custom, { target: { value: "pt_BR" } });
		expect(screen.getByText("Invalid locale code (e.g. en, fr, fr-FR)")).toBeInTheDocument();
		fireEvent.change(custom, { target: { value: " pt-BR " } });
		expect(screen.queryByText(/Invalid locale code/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Back to the list of locales" }));
		expect(screen.getByLabelText("Source locale")).toHaveValue("en");
	});
});

describe("I18nScalerPanel, editor", () => {
	it("offers the project's translation folders and opens one", async () => {
		api.detectI18nRoots.mockResolvedValue({
			success: true,
			roots: [{ path: "/work/shop/locales", relative: "locales", locales: ["en", "fr"], namespaces: 2, layout: "nested" }],
		});
		api.listI18nNamespaces.mockResolvedValue({
			success: true,
			locales: ["en", "fr"],
			locales_dir: "/work/shop/locales",
			layout: "nested",
			namespaces: [{ namespace: "common", total_keys: 2, translated: { en: 2, fr: 1 }, missing: { fr: 1 } }],
		});
		render(<I18nScalerPanel projectPath="/work/shop" />);
		fireEvent.click(screen.getByRole("button", { name: "Editor" }));
		expect(screen.queryByText(/Reads i18next JSON/)).not.toBeInTheDocument();
		expect(screen.getByText("Load the translations to browse and edit them.")).toBeInTheDocument();
		expect(await screen.findByText("Found in this project")).toBeInTheDocument();
		expect(api.detectI18nRoots).toHaveBeenCalledWith("/work/shop");
		expect(screen.getByText("en, fr · 2 namespaces")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /locales/ }));
		expect(await screen.findByText("Pick a namespace on the left to start editing.")).toBeInTheDocument();
		expect(api.listI18nNamespaces).toHaveBeenCalledWith("/work/shop/locales");
		expect(screen.getByText("Read from /work/shop/locales · en, fr")).toBeInTheDocument();
		expect(screen.queryByText("Found in this project")).not.toBeInTheDocument();
	});

	it("loads the picked folder and shows its error in the app's words", async () => {
		api.listI18nNamespaces.mockResolvedValue({ success: false, error: "Directory not found: /gone" });
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
		await waitFor(() => expect(screen.getByLabelText("Locales directory")).toHaveValue("/work/shop/locales"));
		fireEvent.click(screen.getByRole("button", { name: "Load translations" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Directory not found: /gone");
	});

	it("says loading while it reads, and an empty folder lists no locale", async () => {
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Editor" }));
		act(() => useI18nEditorStore.setState({ phase: "loading" }));
		expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
		act(() => useI18nEditorStore.setState({ phase: "ok", localesDir: "/empty", locales: [] }));
		expect(screen.getByText("Read from /empty")).toBeInTheDocument();
	});

	it("shows an editor error once, in the editor, when a namespace is open", () => {
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Editor" }));
		act(() =>
			useI18nEditorStore.setState({
				localesDir: "/l",
				locales: ["en"],
				namespaces: [{ namespace: "common", total_keys: 0, translated: {}, missing: {} }],
				selectedNamespace: "common",
				error: "boom",
			}),
		);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
		expect(screen.getByRole("alert")).toHaveTextContent("Backend error: boom");
	});

	it("runs the report from the report tab once the editor tab was visited", async () => {
		render(<I18nScalerPanel />);
		fireEvent.click(screen.getByRole("button", { name: "Editor" }));
		fireEvent.click(screen.getByRole("button", { name: "Report" }));
		expect(screen.getByRole("button", { name: "Run report" })).toBeInTheDocument();
		expect(api.detectI18nRoots).not.toHaveBeenCalled();
	});
});

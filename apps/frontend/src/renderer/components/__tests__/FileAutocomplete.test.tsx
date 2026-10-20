/**
 * @vitest-environment jsdom
 */
/**
 * The `@` mention popup of a task description searches the whole project.
 * It used to list only what the file explorer had cached — the root folder —
 * so nothing below the first level could be mentioned.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import { FileAutocomplete } from "../FileAutocomplete";

const search = vi.fn();

beforeEach(() => {
	search.mockReset();
	Object.assign(window.electronAPI, { searchProjectFiles: search });
});

describe("FileAutocomplete", () => {
	it("lists nested files from the project-wide search and inserts their relative path", async () => {
		search.mockResolvedValue({
			success: true,
			data: [
				{
					relativePath: "src/features/billing/InvoiceService.cs",
					name: "InvoiceService.cs",
					isDirectory: false,
				},
			],
		});
		const onSelect = vi.fn();
		render(
			<FileAutocomplete
				query="invoice"
				projectPath="/work/project"
				position={{ top: 0, left: 0 }}
				onSelect={onSelect}
				onClose={vi.fn()}
			/>,
		);

		const item = await screen.findByText("InvoiceService.cs");
		expect(search).toHaveBeenCalledWith("/work/project", "invoice", "file");
		fireEvent.click(item);
		expect(onSelect).toHaveBeenCalledWith(
			"src/features/billing/InvoiceService.cs",
		);
	});

	it("keeps only the answer to the latest query", async () => {
		let slow!: (value: unknown) => void;
		search
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						slow = resolve;
					}),
			)
			.mockResolvedValueOnce({
				success: true,
				data: [{ relativePath: "src/App.tsx", name: "App.tsx", isDirectory: false }],
			});
		const props = {
			projectPath: "/work/project",
			position: { top: 0, left: 0 },
			onSelect: vi.fn(),
			onClose: vi.fn(),
		};
		const view = render(<FileAutocomplete query="a" {...props} />);
		await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
		view.rerender(<FileAutocomplete query="app" {...props} />);
		await screen.findByText("App.tsx");
		slow({
			success: true,
			data: [{ relativePath: "a.md", name: "a.md", isDirectory: false }],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(screen.queryByText("a.md")).not.toBeInTheDocument();
		expect(screen.getByText("App.tsx")).toBeInTheDocument();
	});

	it("does not let Enter pick a match for the previous query while the new one loads", async () => {
		let pending!: (value: unknown) => void;
		search
			.mockResolvedValueOnce({
				success: true,
				data: [{ relativePath: "docs/a.md", name: "a.md", isDirectory: false }],
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						pending = resolve;
					}),
			);
		const onSelect = vi.fn();
		const props = {
			projectPath: "/work/project",
			position: { top: 0, left: 0 },
			onSelect,
			onClose: vi.fn(),
		};
		const view = render(<FileAutocomplete query="a" {...props} />);
		await screen.findByText("a.md");
		view.rerender(<FileAutocomplete query="app" {...props} />);
		fireEvent.keyDown(document, { key: "Enter" });
		expect(onSelect).not.toHaveBeenCalled();

		await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
		pending({
			success: true,
			data: [{ relativePath: "src/App.tsx", name: "App.tsx", isDirectory: false }],
		});
		await screen.findByText("App.tsx");
		fireEvent.keyDown(document, { key: "Enter" });
		expect(onSelect).toHaveBeenCalledWith("src/App.tsx");
	});
});

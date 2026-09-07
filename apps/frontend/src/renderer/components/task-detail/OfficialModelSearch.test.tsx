import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { OfficialModelSearch } from "./OfficialModelSearch";
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
afterEach(() => vi.unstubAllGlobals());
const reply = (models: { value: string; source: string }[]) => ({
	ok: true,
	json: async () => ({ models }),
});
const model = {
	value: "qwen3:8b",
	source: "https://ollama.com/library/qwen3:8b",
};

describe("official model search", () => {
	it("only selects an official result, never the typed text", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([model])));
		const select = vi.fn();
		render(<OfficialModelSearch onSelect={select} onClose={vi.fn()} />);
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(select).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole("option", { name: "qwen3:8b" }));
		expect(select).toHaveBeenCalledWith("qwen3:8b");
	});
	it("clears old results immediately while another query is pending", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(reply([model]))
			.mockImplementation(
				() =>
					new Promise(() => {
						/* Keep the next request pending. */
					}),
			);
		vi.stubGlobal("fetch", fetcher);
		const select = vi.fn();
		render(<OfficialModelSearch onSelect={select} onClose={vi.fn()} />);
		await screen.findByRole("option");
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "invented-model" },
		});
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		expect(screen.queryByRole("option")).toBeNull();
		expect(select).not.toHaveBeenCalled();
	});
	it("fails closed when the official source is unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		render(<OfficialModelSearch onSelect={vi.fn()} onClose={vi.fn()} />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"tasks:logs.model.searchError",
		);
		expect(screen.queryByRole("option")).toBeNull();
	});
	it("supports keyboard selection", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply([model])));
		const select = vi.fn();
		render(<OfficialModelSearch onSelect={select} onClose={vi.fn()} />);
		await screen.findByRole("option");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
		await waitFor(() => expect(select).toHaveBeenCalledWith("qwen3:8b"));
	});
});

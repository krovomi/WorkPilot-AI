/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";

describe("searchable model and provider lists", () => {
	it("sorts labels, filters IDs, preserves the selection and selects a visible result", async () => {
		const change = vi.fn();
		render(
			<Select defaultOpen defaultValue="zeta" onValueChange={change}>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent searchable>
					<SelectItem value="zeta">Zeta</SelectItem>
					<SelectItem value="gemma4:12b">Alpha</SelectItem>
					<SelectItem value="beta" disabled>
						Beta
					</SelectItem>
				</SelectContent>
			</Select>,
		);
		await screen.findByRole("searchbox");
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual(["Alpha", "Beta", "Zeta"]);
		fireEvent.change(screen.getByRole("searchbox"), {
			target: { value: "GEMMA4" },
		});
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual(["Alpha"]);
		expect(screen.getByRole("combobox", { hidden: true })).toHaveTextContent(
			"Zeta",
		);
		fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
		await waitFor(() => expect(screen.getByRole("option")).toHaveFocus());
		fireEvent.keyDown(screen.getByRole("option"), { key: "Enter" });
		expect(change).toHaveBeenCalledWith("gemma4:12b");
		fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
		expect(await screen.findByRole("searchbox")).toHaveValue("");
		expect(screen.getAllByRole("option")).toHaveLength(3);
		expect(screen.getByRole("option", { name: "Beta" })).toHaveAttribute(
			"data-disabled",
		);
	});
	it("shows an empty state and does not sort ordinary ordered lists", async () => {
		const { unmount } = render(
			<Select defaultOpen>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent searchable>
					<SelectItem value="a">Alpha</SelectItem>
				</SelectContent>
			</Select>,
		);
		fireEvent.change(await screen.findByRole("searchbox"), {
			target: { value: "missing" },
		});
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(screen.getByText("No results")).toBeInTheDocument();
		unmount();
		render(
			<Select defaultOpen>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="z">Zeta</SelectItem>
					<SelectItem value="a">Alpha</SelectItem>
				</SelectContent>
			</Select>,
		);
		expect(
			(await screen.findAllByRole("option")).map(
				(option) => option.textContent,
			),
		).toEqual(["Zeta", "Alpha"]);
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
	});
});

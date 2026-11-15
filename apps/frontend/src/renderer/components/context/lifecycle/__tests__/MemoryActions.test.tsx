/** @vitest-environment jsdom */
/**
 * One memory's actions in the Memories tab: pin, forget with a reason
 * (restorable), and its timeline.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import { MemoryActions } from "../MemoryActions";

const ID = "knowledge/projects/shop/memory/gotchas/x.md";
const api = { pinMemory: vi.fn(), forgetMemory: vi.fn(), getMemoryHistory: vi.fn() };

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("en");
});
afterEach(() => cleanup());

describe("MemoryActions", () => {
	it("pins, then reloads the list", async () => {
		api.pinMemory.mockResolvedValue({ success: true, data: { count: 1 } });
		const changed = vi.fn();
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={changed} />);
		fireEvent.click(screen.getByRole("button", { name: "Pin" }));
		await waitFor(() => expect(changed).toHaveBeenCalled());
		expect(api.pinMemory).toHaveBeenCalledWith("p1", ID, true);
	});

	it("says why a pin was refused", async () => {
		api.pinMemory.mockResolvedValue({ success: false, error: "pin-limit" });
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Pin" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("pin limit reached");
	});

	it("forgets with the person's reason, after a confirmation", async () => {
		api.forgetMemory.mockResolvedValue({ success: true });
		render(<MemoryActions projectId="p1" memoryId={ID} pinned onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Forget" }));
		expect(api.forgetMemory).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Why (optional)"), { target: { value: "obsolete" } });
		fireEvent.click(screen.getByRole("button", { name: "Forget it" }));
		await waitFor(() => expect(api.forgetMemory).toHaveBeenCalledWith("p1", ID, "obsolete"));
	});

	it("shows the memory's timeline", async () => {
		api.getMemoryHistory.mockResolvedValue({
			success: true,
			data: [
				{
					id: "e1",
					ts: "2026-11-14T10:00:00+00:00",
					action: "merge",
					actor: "learning-loop",
					note: ID,
					title: "",
					preview: "",
					reason_code: "similar-merged",
					reason: "",
					related: [],
				},
			],
		});
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		expect(
			await screen.findByText(/Merged by the learning loop — a similar pattern was merged into it/),
		).toBeInTheDocument();
	});
});

describe("MemoryActions when things go wrong", () => {
	it("says the action failed when the call throws", async () => {
		api.pinMemory.mockRejectedValue(new Error("ipc down"));
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Pin" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("the action failed");
	});

	it("keeps the confirmation open when the forget is refused", async () => {
		api.forgetMemory.mockResolvedValue({ success: false, error: "pinned" });
		render(<MemoryActions projectId="p1" memoryId={ID} pinned onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Forget" }));
		fireEvent.click(screen.getByRole("button", { name: "Forget it" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("this memory is pinned");
		expect(screen.getByRole("button", { name: "Forget it" })).toBeInTheDocument();
	});

	it("hides the timeline again, says when it is empty and when it cannot be read", async () => {
		api.getMemoryHistory.mockResolvedValueOnce({ success: true });
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByText("No decision recorded yet.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Hide history" }));
		expect(screen.queryByText("No decision recorded yet.")).not.toBeInTheDocument();

		api.getMemoryHistory.mockResolvedValueOnce({ success: false, error: "not-found" });
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("this memory no longer exists");
	});

	it("names an agent by its type in the timeline", async () => {
		api.getMemoryHistory.mockResolvedValue({
			success: true,
			data: [
				{
					id: "e2",
					ts: "2026-11-14T10:00:00+00:00",
					action: "merge",
					actor: "agent:coder",
					note: "gotchas/x.md",
					title: "",
					preview: "",
					reason_code: "similar-merged",
					reason: "",
					related: [],
				},
			],
		});
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		expect(await screen.findByText(/by the coder agent/)).toBeInTheDocument();
	});
});

/** @vitest-environment jsdom */
/**
 * The rules a team keeps (#352): a pair that flip-flops is escalated and
 * waits for a maintainer, the maintainers are named in the tab, a person's
 * decision carries their name, and a memory can be scoped to a part of the code.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { MemoryConflict, MemoryLifecycleView } from "../../../../../shared/types";
import { LifecycleTab } from "../LifecycleTab";
import { MemoryActions } from "../MemoryActions";

const BASE = "knowledge/projects/shop/memory";

function side(name: string, text: string) {
	return {
		path: `${BASE}/gotchas/${name}.md`,
		title: name,
		text,
		preview: "",
		updated: "",
		pinned: false,
		confidence: null,
		agents: [],
		tasks: [],
	};
}

const ESCALATED: MemoryConflict = {
	id: "0123456789abcdef",
	kind: "gotcha",
	signal: "negation",
	detail: "",
	textual: false,
	detected_at: "2026-11-20T10:00:00+00:00",
	escalated: { at: "2026-11-18T10:00:00+00:00", by: "Alice", actor: "user", reason_code: "person-chose" },
	a: side("always", "Always run the migrations."),
	b: side("never", "Never run the migrations."),
};

function view(over: Partial<MemoryLifecycleView> = {}): MemoryLifecycleView {
	return {
		pinned: 0,
		pinLimit: 50,
		retentionDays: 30,
		revertible: {},
		lastUndo: null,
		metrics: null,
		maintainers: ["Bob"],
		canArbitrate: false,
		trash: [],
		conflicts: [ESCALATED],
		journal: [
			{
				id: "e1",
				ts: "2026-11-18T10:00:00+00:00",
				action: "resolve",
				actor: "user",
				by: "Alice",
				note: `${BASE}/gotchas/always.md`,
				title: "Always",
				preview: "",
				reason_code: "person-chose",
				reason: "",
				related: [],
			},
		],
		...over,
	};
}

const api = {
	getMemoryLifecycle: vi.fn(),
	resolveMemoryConflict: vi.fn(),
	setMemoryMaintainers: vi.fn(),
	setMemoryScope: vi.fn(),
	pinMemory: vi.fn(),
	forgetMemory: vi.fn(),
	getMemoryHistory: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.getMemoryLifecycle.mockResolvedValue({ success: true, data: view() });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("a conflict that flip-flops", () => {
	it("waits for a maintainer: the person here cannot settle it", async () => {
		render(<LifecycleTab projectId="p1" />);
		const notice = await screen.findByTestId("memory-conflict-escalated");
		expect(notice).toHaveTextContent("by Alice, and contradicted again: a maintainer settles it.");
		expect(notice).toHaveTextContent("Waiting for a maintainer: Bob.");
		for (const button of screen.getAllByRole("button", { name: "Keep this one" })) {
			expect(button).toBeDisabled();
		}
		expect(screen.getByRole("button", { name: "Not a conflict" })).toBeDisabled();
	});

	it("is settled by a maintainer", async () => {
		api.getMemoryLifecycle.mockResolvedValue({ success: true, data: view({ canArbitrate: true }) });
		api.resolveMemoryConflict.mockResolvedValue({ success: true, data: { canonical: null } });
		render(<LifecycleTab projectId="p1" />);
		const notice = await screen.findByTestId("memory-conflict-escalated");
		expect(notice).not.toHaveTextContent("Waiting for a maintainer");
		fireEvent.click(screen.getByRole("button", { name: "Not a conflict" }));
		await waitFor(() =>
			expect(api.resolveMemoryConflict).toHaveBeenCalledWith("p1", ESCALATED.id, "dismiss", ""),
		);
	});
});

describe("the maintainers and the decisions", () => {
	it("lists the decisions with who made them", async () => {
		render(<LifecycleTab projectId="p1" />);
		const decisions = await screen.findByTestId("memory-decisions");
		expect(decisions).toHaveTextContent("Conflict resolved by Alice — a person chose");
	});

	it("names the maintainers and saves a new list", async () => {
		api.setMemoryMaintainers.mockResolvedValue({ success: true, data: ["Bob", "carol@example.com"] });
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("Maintainers: Bob")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		const input = screen.getByRole("textbox", { name: "Names or e-mails, separated by commas" });
		expect(input).toHaveValue("Bob");
		fireEvent.change(input, { target: { value: " Bob , carol@example.com, " } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(api.setMemoryMaintainers).toHaveBeenCalledWith("p1", ["Bob", "carol@example.com"]),
		);
		await waitFor(() => expect(api.getMemoryLifecycle).toHaveBeenCalledTimes(2));
		expect(screen.queryByRole("textbox", { name: "Names or e-mails, separated by commas" })).toBeNull();
	});

	it("says why a list was refused, and puts the pen down on cancel", async () => {
		api.getMemoryLifecycle.mockResolvedValue({
			success: true,
			data: view({ maintainers: [], conflicts: [], journal: [] }),
		});
		api.setMemoryMaintainers.mockResolvedValue({ success: false, error: "invalid" });
		render(<LifecycleTab projectId="p1" />);
		expect(
			await screen.findByText("No maintainer: anyone settles a conflict that flip-flops."),
		).toBeInTheDocument();
		expect(screen.queryByTestId("memory-decisions")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("invalid request");
		expect(api.setMemoryMaintainers).toHaveBeenCalledWith("p1", []);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByText("Mainteneurs : Bob")).toBeInTheDocument();
		expect(screen.getByTestId("memory-conflict-escalated")).toHaveTextContent(
			"En attente d'un mainteneur : Bob.",
		);
	});
});

describe("a memory's scope", () => {
	const ID = `${BASE}/gotchas/x.md`;

	it("shows where a memory applies and changes it", async () => {
		api.setMemoryScope.mockResolvedValue({ success: true, data: { appliesTo: "apps/auth/" } });
		const changed = vi.fn();
		render(
			<MemoryActions projectId="p1" memoryId={ID} pinned={false} appliesTo="apps/billing/" onChanged={changed} />,
		);
		expect(screen.getByText("Applies to apps/billing/")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Scope" }));
		const input = screen.getByRole("textbox", { name: /Where it applies/ });
		expect(input).toHaveValue("apps/billing/");
		fireEvent.change(input, { target: { value: "apps/auth/" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(changed).toHaveBeenCalled());
		expect(api.setMemoryScope).toHaveBeenCalledWith("p1", ID, "apps/auth/");
		expect(screen.queryByRole("textbox", { name: /Where it applies/ })).toBeNull();
	});

	it("keeps the field open when the scope is refused, and closes it on a second click", async () => {
		api.setMemoryScope.mockResolvedValue({ success: false, error: "invalid" });
		render(<MemoryActions projectId="p1" memoryId={ID} pinned={false} onChanged={vi.fn()} />);
		expect(screen.queryByText(/Applies to/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Scope" }));
		expect(screen.getByRole("textbox", { name: /Where it applies/ })).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("invalid request");
		expect(screen.getByRole("textbox", { name: /Where it applies/ })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Scope" }));
		expect(screen.queryByRole("textbox", { name: /Where it applies/ })).toBeNull();
	});
});

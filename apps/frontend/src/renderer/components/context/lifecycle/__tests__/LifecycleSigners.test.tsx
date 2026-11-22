/** @vitest-environment jsdom */
/**
 * The trusted signers (#352): the list a person edits in the Lifecycle tab,
 * and the "unverified" mark wherever a person reads a memory no trusted key
 * signed (the journal, a memory's actions and its history, a search hit).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { MemoryLifecycleView } from "../../../../../shared/types";
import { MemoriesTab } from "../../MemoriesTab";
import { LifecycleTab } from "../LifecycleTab";
import { MemoryActions } from "../MemoryActions";
import { SignersEditor } from "../SignersEditor";

const BASE = "knowledge/projects/shop/memory";
const NOTE = `${BASE}/gotchas/eve.md`;
const ALICE = { name: "alice@example.com", kind: "ssh" as const, fingerprint: "SHA256:abc" };

function view(over: Partial<MemoryLifecycleView> = {}): MemoryLifecycleView {
	return {
		pinned: 0,
		pinLimit: 50,
		retentionDays: 30,
		signers: [ALICE],
		signersRejected: 0,
		signing: true,
		canEditSigners: true,
		unverified: [NOTE],
		revertible: {},
		lastUndo: null,
		metrics: null,
		maintainers: [],
		maintainerScopes: {},
		canArbitrate: true,
		trash: [],
		conflicts: [],
		journal: [
			{
				id: "e1",
				ts: "2026-11-20T10:00:00+00:00",
				action: "create",
				actor: "agent",
				note: NOTE,
				title: "Eve",
				preview: "",
				reason_code: "recorded",
				reason: "",
				related: [],
			},
			{
				id: "e2",
				ts: "2026-11-20T09:00:00+00:00",
				action: "create",
				actor: "agent",
				note: `${BASE}/gotchas/alice.md`,
				title: "Alice",
				preview: "",
				reason_code: "recorded",
				reason: "",
				related: [],
			},
		],
		...over,
	};
}

const api = {
	getMemoryLifecycle: vi.fn(),
	setMemorySigners: vi.fn(),
	setMemoryMaintainers: vi.fn(),
	getMemoryHistory: vi.fn(),
	pinMemory: vi.fn(),
	forgetMemory: vi.fn(),
	setMemoryScope: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.getMemoryLifecycle.mockResolvedValue({ success: true, data: view() });
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

function editor(over: Partial<Parameters<typeof SignersEditor>[0]> = {}) {
	const saved = vi.fn();
	render(
		<SignersEditor
			projectId="p1"
			signers={[ALICE]}
			rejected={0}
			signing
			canEdit
			unverified={0}
			onSaved={saved}
			{...over}
		/>,
	);
	return saved;
}

describe("the trusted signers", () => {
	it("says that without a list every note is trusted as before", () => {
		editor({ signers: [], signing: false, unverified: 3 });
		expect(
			screen.getByText("No trusted signer: every note reaches the agents, as before."),
		).toBeInTheDocument();
		// Nothing is unverified, and not signing matters to nobody, without a list.
		expect(screen.queryByTestId("memory-signers-unverified")).toBeNull();
		expect(screen.queryByTestId("memory-signers-not-signing")).toBeNull();
	});

	it("names the signers, counts the unverified memories and the refused changes", () => {
		editor({ unverified: 2, rejected: 1, signing: false });
		expect(screen.getByText("Trusted: alice@example.com (ssh)")).toBeInTheDocument();
		expect(screen.getByTestId("memory-signers-unverified")).toHaveTextContent(
			"2 memories are unverified",
		);
		expect(
			screen.getByText("1 change to this list was not signed by a listed key and is ignored."),
		).toBeInTheDocument();
		expect(screen.getByTestId("memory-signers-not-signing")).toHaveTextContent(
			"This machine does not sign its commits",
		);
	});

	it("saves one signer per line, trimmed, then reloads", async () => {
		api.setMemorySigners.mockResolvedValue({ success: true, data: [ALICE] });
		const saved = editor();
		fireEvent.click(screen.getByRole("button", { name: "Edit the list" }));
		const box = screen.getByRole("textbox", {
			name: "One per line: name ssh-ed25519 AAAA… or name GPG fingerprint",
		});
		fireEvent.change(box, { target: { value: " alice ssh-ed25519 AAAA \n\n dan ABCD " } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(saved).toHaveBeenCalled());
		expect(api.setMemorySigners).toHaveBeenCalledWith("p1", [
			"alice ssh-ed25519 AAAA",
			"dan ABCD",
		]);
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("says why a list was refused, and puts the pen down on cancel", async () => {
		api.setMemorySigners.mockResolvedValueOnce({ success: false, error: "maintainer-only" });
		api.setMemorySigners.mockResolvedValueOnce({ success: false, error: "invalid" });
		editor();
		fireEvent.click(screen.getByRole("button", { name: "Edit the list" }));
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Only a maintainer changes this list.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid request"));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("is edited by a maintainer when the project has some", () => {
		editor({ canEdit: false });
		expect(screen.getByRole("button", { name: "Edit the list" })).toBeDisabled();
		expect(screen.getByText("Only a maintainer changes this list.")).toBeInTheDocument();
	});
});

describe("the unverified mark", () => {
	it("is on the journal entries of an unverified memory, with the list above", async () => {
		render(<LifecycleTab projectId="p1" />);
		expect(await screen.findByTestId("memory-signers-section")).toHaveTextContent(
			"Trusted signers",
		);
		const marks = await screen.findAllByTestId("memory-unverified");
		expect(marks).toHaveLength(1);
		expect(marks[0].closest("li")).toHaveTextContent("eve.md");
	});

	it("is not offered for a server project's memory", async () => {
		render(<LifecycleTab projectId="p1" onServer />);
		await screen.findByTestId("memory-lifecycle");
		await waitFor(() => expect(api.getMemoryLifecycle).toHaveBeenCalled());
		expect(screen.queryByTestId("memory-signers-section")).toBeNull();
	});

	it("is on a memory's actions and its history", async () => {
		api.getMemoryHistory.mockResolvedValue({ success: true, data: view().journal.slice(0, 1) });
		render(
			<MemoryActions projectId="p1" memoryId={NOTE} pinned={false} unverified onChanged={vi.fn()} />,
		);
		expect(screen.getAllByTestId("memory-unverified")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "History" }));
		await waitFor(() => expect(screen.getAllByTestId("memory-unverified")).toHaveLength(2));
	});

	it("is on a search hit no trusted key signed", () => {
		render(
			<MemoriesTab
				memoryStatus={null}
				memoryState={null}
				recentMemories={[]}
				memoriesLoading={false}
				searchResults={[
					{ type: "gotcha", content: "Eve's advice", score: 1, verified: false },
					{ type: "gotcha", content: "Alice's advice", score: 0.5 },
				]}
				searchLoading={false}
				onSearch={vi.fn()}
			/>,
		);
		expect(screen.getAllByTestId("memory-unverified")).toHaveLength(1);
	});
});

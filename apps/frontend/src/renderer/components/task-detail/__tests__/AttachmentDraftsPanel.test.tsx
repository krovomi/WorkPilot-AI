/**
 * @vitest-environment jsdom
 */

/**
 * AttachmentDraftsPanel — what the attachments propose, and what a person keeps.
 *
 * Pinned: nothing is said when nothing is proposed; a specification can be read
 * on request; nothing reaches the spec without a tick; accepted criteria join
 * the task's own list through its normal save path; a rule table carries its
 * parametrised test; a whiteboard photo is converted only with a vision model.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";

const api = vi.hoisted(() => ({
	fetchDocintelDrafts: vi.fn(),
	extractDocintelDrafts: vi.fn(),
	decideDocintelDrafts: vi.fn(),
	convertWhiteboard: vi.fn(),
	fetchDocintel: vi.fn(),
}));
const persist = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/agent-tools-api", () => api);
vi.mock("../../../stores/task-store", () => ({ persistUpdateTask: persist }));
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
		i18n: { language: "fr" },
	}),
}));

import { useDocintelDraftsStore } from "../../../stores/docintel-drafts-store";
import { useDocintelStore } from "../../../stores/docintel-store";
import { AttachmentDraftsPanel } from "../AttachmentDraftsPanel";

const task = {
	id: "t1",
	specId: "001-orders",
	description: "Orders",
	metadata: { acceptanceCriteria: ["Existing criterion"] },
} as unknown as Task;

const requirement = {
	key: "req-1",
	id: "FR-002",
	kind: "FR",
	text: "Le système doit afficher les commandes.",
	source: "attachments/cdc.pdf",
	page: 1,
	ref: "EF-01",
	status: "proposed",
};
const criterion = {
	key: "ac-1",
	text: "Un client voit ses commandes triées par date",
	source: "attachments/cdc.pdf",
	page: 2,
	status: "proposed",
};
const table = {
	key: "table-1",
	table: {
		headers: ["Type", "Remise attendue"],
		rows: [
			["Standard", "0"],
			["Gold", "12,5"],
		],
		caption: "Remise par type",
		source: "aligned",
		page: 0,
	},
	source: "attachments/regles.md",
	tests: [
		{ language: "csharp", framework: "xunit", code: "[Theory] CSHARP", notes: [] },
		{ language: "python", framework: "pytest", code: "@pytest.mark.parametrize PY", notes: [] },
	],
	status: "proposed",
};

function payload(overrides: Record<string, unknown> = {}) {
	return {
		ok: true as const,
		data: {
			drafts: null,
			pending: 0,
			readable: [],
			pdfBackends: ["pypdfium2"],
			vision: { images: [], available: false, reason: "no-image" },
			...overrides,
		},
	};
}

function withDrafts(extra: Record<string, unknown> = {}) {
	return payload({
		drafts: {
			requirements: [requirement],
			criteria: [criterion],
			tables: [table],
			sources: ["attachments/cdc.pdf"],
			generated_at: "",
		},
		pending: 2,
		readable: ["attachments/cdc.pdf"],
		...extra,
	});
}

function renderPanel() {
	return render(<AttachmentDraftsPanel task={task} projectPath="/p" />);
}

beforeEach(() => {
	vi.clearAllMocks();
	useDocintelDraftsStore.setState({ byTask: {} });
	useDocintelStore.setState({ byTask: {} });
	api.fetchDocintel.mockResolvedValue({ ok: false, error: "unused" });
	persist.mockResolvedValue(true);
});

describe("AttachmentDraftsPanel", () => {
	it("renders nothing when there is nothing to propose", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(
			payload({ readable: ["attachments/mockup.png"] }),
		);
		const { container } = renderPanel();
		await waitFor(() => expect(api.fetchDocintelDrafts).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("offers to read a specification, and reads it on request", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(
			payload({ readable: ["attachments/cdc.pdf"] }),
		);
		api.extractDocintelDrafts.mockResolvedValueOnce(withDrafts());
		renderPanel();
		fireEvent.click(await screen.findByText("tasks:docintel.drafts.extract"));
		expect(await screen.findByDisplayValue(requirement.text)).toBeInTheDocument();
		expect(api.extractDocintelDrafts).toHaveBeenCalledWith(
			expect.objectContaining({ projectDir: "/p", specId: "001-orders" }),
			expect.anything(),
		);
		// The card above it re-reads what the attachments became.
		expect(api.fetchDocintel).toHaveBeenCalled();
	});

	it("adds nothing without a tick, then sends exactly what was kept", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(withDrafts());
		// After the decision: nothing left to decide, the table still there.
		const decided = withDrafts({
			pending: 0,
			drafts: {
				requirements: [],
				criteria: [],
				tables: [table],
				sources: ["attachments/cdc.pdf"],
				generated_at: "",
			},
		});
		api.decideDocintelDrafts.mockResolvedValueOnce({
			...decided,
			data: {
				...decided.data,
				decision: {
					requirements: [{ id: "FR-002", text: "Edited", key: "req-1" }],
					criteria: [criterion.text],
					spec_updated: false,
					description_section: "\n\n## Requirements from attachments\n\n- **FR-002**: Edited\n",
					traceability: "",
				},
			},
		});
		renderPanel();
		const accept = await screen.findByText("tasks:docintel.drafts.accept:0");
		expect(accept.closest("button")).toBeDisabled();

		fireEvent.change(screen.getByDisplayValue(requirement.text), {
			target: { value: "Edited" },
		});
		fireEvent.click(screen.getByLabelText("tasks:docintel.drafts.select"));
		fireEvent.click(screen.getByLabelText("tasks:docintel.drafts.selectCriterion"));
		fireEvent.click(screen.getByText("tasks:docintel.drafts.accept:2"));

		await waitFor(() => expect(api.decideDocintelDrafts).toHaveBeenCalled());
		expect(api.decideDocintelDrafts.mock.calls[0][1]).toEqual({
			acceptRequirements: { "req-1": "Edited" },
			acceptCriteria: { "ac-1": criterion.text },
		});
		await waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
		expect(persist).toHaveBeenNthCalledWith(1, "t1", {
			metadata: { acceptanceCriteria: ["Existing criterion", criterion.text] },
		});
		expect(persist.mock.calls[1][1].description).toContain(
			"## Requirements from attachments",
		);
		expect(toast).toHaveBeenCalled();
	});

	it("rejects what was ticked", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(withDrafts());
		api.decideDocintelDrafts.mockResolvedValueOnce({
			ok: true,
			data: { ...withDrafts().data, decision: { requirements: [], criteria: [] } },
		});
		renderPanel();
		fireEvent.click(await screen.findByLabelText("tasks:docintel.drafts.select"));
		fireEvent.click(screen.getByText("tasks:docintel.drafts.reject:1"));
		await waitFor(() =>
			expect(api.decideDocintelDrafts.mock.calls[0][1]).toEqual({
				rejectRequirements: ["req-1"],
				rejectCriteria: [],
			}),
		);
		expect(persist).not.toHaveBeenCalled();
	});

	it("shows a rule table with the test of each language, and can dismiss it", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(withDrafts());
		api.decideDocintelDrafts.mockResolvedValueOnce({
			ok: true,
			data: { ...withDrafts().data, decision: { requirements: [], criteria: [] } },
		});
		renderPanel();
		expect(await screen.findByText("Remise par type")).toBeInTheDocument();
		expect(screen.getByText("[Theory] CSHARP")).toBeInTheDocument();
		fireEvent.click(screen.getAllByText("tasks:docintel.rules.framework")[1]);
		expect(screen.getByText("@pytest.mark.parametrize PY")).toBeInTheDocument();
		fireEvent.click(screen.getByText("tasks:docintel.rules.dismiss"));
		await waitFor(() =>
			expect(api.decideDocintelDrafts.mock.calls[0][1]).toEqual({
				rejectTables: ["table-1"],
			}),
		);
	});

	it("says there is no vision model instead of guessing a diagram", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(
			payload({
				vision: {
					images: ["attachments/board.jpg"],
					available: false,
					reason: "model-not-installed",
				},
			}),
		);
		renderPanel();
		expect(
			await screen.findByText("tasks:docintel.whiteboard.unavailable"),
		).toBeInTheDocument();
		expect(screen.queryByText("tasks:docintel.whiteboard.convert")).toBeNull();
	});

	it("converts a whiteboard photo with the local vision model", async () => {
		api.fetchDocintelDrafts.mockResolvedValueOnce(
			payload({
				vision: { images: ["attachments/board.jpg"], available: true, reason: "" },
			}),
		);
		api.convertWhiteboard.mockResolvedValueOnce({
			ok: true,
			data: {
				result: {
					status: "converted",
					reason: "",
					path: "attachments/board.whiteboard.drawio",
					nodes: 4,
					edges: 2,
					secrets: [],
					conformance: { status: "checked", findings: 1, inverted: 0 },
				},
			},
		});
		renderPanel();
		fireEvent.click(await screen.findByText("tasks:docintel.whiteboard.convert"));
		expect(await screen.findByText(/tasks:docintel.whiteboard.converted/)).toBeInTheDocument();
		expect(api.convertWhiteboard.mock.calls[0][1]).toBe("attachments/board.jpg");
		expect(screen.getByText(/tasks:docintel.whiteboard.conformance:1/)).toBeInTheDocument();
	});
});

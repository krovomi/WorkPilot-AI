/**
 * @vitest-environment jsdom
 */

/**
 * DocumentInsightsCard — what the agents will read from a task's attachments
 * and which ADRs bind the build.
 *
 * Two properties are pinned: the card says nothing when there is nothing to
 * say (no attachment, no ADR), and an attachment whose text was withheld as a
 * possible injection is shown as such rather than as an ordinary document.
 * A screenshot showing a secret is shown as masked or withheld, naming the
 * kind of secret — the card never receives the value.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";

const mockFetch = vi.fn();

vi.mock("../../../lib/agent-tools-api", () => ({
	fetchDocintel: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
	}),
}));

import { useDocintelStore } from "../../../stores/docintel-store";
import { DocumentInsightsCard } from "../DocumentInsightsCard";

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

function answer(
	documents: unknown[],
	adrs: unknown[] = [],
	checks: Record<string, unknown> = {},
) {
	return {
		ok: true as const,
		data: { documents, adrs, erd: null, sequences: [], apiTests: [], ...checks },
	};
}

const diagram = {
	path: "attachments/archi.drawio",
	status: "diagram",
	engine: "drawio",
	reason: "",
	threat: "safe",
	secrets: [] as string[],
	described: false,
	nodeCount: 4,
	edgeCount: 2,
};

beforeEach(() => {
	vi.clearAllMocks();
	useDocintelStore.setState({ byTask: {} });
});

describe("DocumentInsightsCard", () => {
	it("renders nothing when there is neither attachment nor ADR", async () => {
		mockFetch.mockResolvedValueOnce(answer([]));
		const { container } = render(
			<DocumentInsightsCard task={task} projectPath="/p" />,
		);
		await waitFor(() => expect(mockFetch).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("does not ask without a project", () => {
		render(<DocumentInsightsCard task={task} />);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("lists attachments and accepted ADRs", async () => {
		mockFetch.mockResolvedValueOnce(
			answer(
				[diagram],
				[
					{
						id: "ADR-0003",
						title: "Use clean architecture",
						status: "accepted",
						path: "docs/adr/0003.md",
						decision: "",
						binding: true,
					},
					{
						id: "ADR-0001",
						title: "Single project",
						status: "superseded",
						path: "docs/adr/0001.md",
						decision: "",
						binding: false,
					},
				],
			),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		expect(
			await screen.findByText("tasks:docintel.badge.attachments:1"),
		).toBeInTheDocument();
		expect(screen.getByText("tasks:docintel.badge.adrs:1")).toBeInTheDocument();

		fireEvent.click(screen.getByText("tasks:docintel.expand"));
		expect(screen.getByText("archi.drawio")).toBeInTheDocument();
		expect(screen.getByText("ADR-0003")).toBeInTheDocument();
		expect(screen.queryByText("ADR-0001")).not.toBeInTheDocument();
	});

	it("marks an attachment whose text was withheld", async () => {
		mockFetch.mockResolvedValueOnce(
			answer([{ ...diagram, path: "attachments/note.txt", threat: "blocked" }]),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		expect(
			await screen.findByText("tasks:docintel.badge.flagged:1"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByText("tasks:docintel.expand"));
		expect(
			screen.getByText(/tasks:docintel\.detail\.flagged/),
		).toBeInTheDocument();
	});

	it("says a screenshot showing a secret was masked, by kind", async () => {
		mockFetch.mockResolvedValueOnce(
			answer([
				{
					...diagram,
					path: "attachments/portal.png",
					status: "redacted",
					engine: "tesseract",
					secrets: ["Azure Storage account key"],
				},
			]),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		expect(
			await screen.findByText("tasks:docintel.badge.secrets:1"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByText("tasks:docintel.expand"));
		expect(
			screen.getByText(/tasks:docintel\.detail\.redacted/),
		).toBeInTheDocument();
	});

	it("says a withheld image is not given to the agents", async () => {
		mockFetch.mockResolvedValueOnce(
			answer([
				{
					...diagram,
					path: "attachments/note.png",
					status: "withheld",
					reason: "injection",
					threat: "blocked",
				},
				{
					...diagram,
					path: "attachments/keys.png",
					status: "withheld",
					reason: "secret-no-boxes",
					secrets: ["JSON Web Token"],
				},
			]),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		fireEvent.click(await screen.findByText("tasks:docintel.expand"));
		expect(
			screen.getByText(/tasks:docintel\.detail\.withheldInjection/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/tasks:docintel\.detail\.withheld$/),
		).toBeInTheDocument();
	});

	it("names the OCR engine that answered", async () => {
		mockFetch.mockResolvedValueOnce(
			answer([
				{
					...diagram,
					path: "attachments/error.png",
					status: "text",
					engine: "ollama-vision",
					described: true,
				},
			]),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		fireEvent.click(await screen.findByText("tasks:docintel.expand"));
		expect(
			screen.getByText(/tasks:docintel\.detail\.described/),
		).toBeInTheDocument();
	});

	it("shows what the diagrams and HTTP calls say of the code, even alone", async () => {
		mockFetch.mockResolvedValueOnce(
			answer([], [], {
				erd: {
					diagrams: [{ path: "docs/model.dbml", origin: "repository" }],
					findings: 2,
					kinds: ["missing-entity"],
					ambiguous: 1,
				},
				sequences: [
					{
						path: "docs/create-order.puml",
						origin: "repository",
						verified: 2,
						checkable: 3,
					},
				],
				apiTests: [
					{
						method: "POST",
						path: "/api/orders",
						status: 201,
						origin: "postman",
						destination: "tests/Acme.Api.Tests/OrdersApiTests.cs",
						stack: "aspnetcore",
					},
				],
			}),
		);
		render(<DocumentInsightsCard task={task} projectPath="/p" />);

		expect(
			await screen.findByText("tasks:docintel.badge.codeChecks:3"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByText("tasks:docintel.expand"));
		expect(screen.getByText("tasks:docintel.code.title")).toBeInTheDocument();
		expect(
			screen.getByText(/tasks:docintel\.code\.erdFindings:2/),
		).toBeInTheDocument();
		expect(screen.getByText("tasks:docintel.code.sequence")).toBeInTheDocument();
		expect(screen.getByText("POST /api/orders")).toBeInTheDocument();
	});
});

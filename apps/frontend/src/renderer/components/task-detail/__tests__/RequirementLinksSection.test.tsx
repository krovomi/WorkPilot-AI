/**
 * @vitest-environment jsdom
 */

/**
 * The traceability card's links (prospective P3).
 *
 * Pinned: the card shows up for a requirement without a test or an earlier
 * requirement on the same files even when the spec and the plan agree; each
 * requirement lists its tests and its untested files; the earlier ones are
 * named by task and id; links never loaded leave the card as it was.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { TraceabilityLinks, TraceabilityPayload } from "../../../lib/agent-tools-api";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));

const store = vi.hoisted(() => ({ data: null as TraceabilityPayload | null }));

vi.mock("../../../stores/spec-traceability-store", () => ({
	useSpecTraceabilityStore: (select: (s: unknown) => unknown) =>
		select({
			load: vi.fn(),
			clear: vi.fn(),
			byTask: { t1: { traceability: store.data } },
		}),
}));

import { SpecTraceabilityCard } from "../SpecTraceabilityCard";

const task = { id: "t1", specId: "001-orders" } as unknown as Task;

const LINKS: TraceabilityLinks = {
	spec: "001-orders",
	head: "abc",
	source: "agent-trace",
	requirements: [
		{
			id: "FR-001",
			title: "List the orders",
			subtasks: ["s1"],
			files: ["src/orders.py", "tests/test_orders.py"],
			tests: ["tests/test_orders.py"],
			untested: [],
		},
		{
			id: "FR-002",
			title: "Export the orders",
			subtasks: ["s2"],
			files: ["src/export.ts"],
			tests: [],
			untested: ["src/export.ts"],
		},
	],
	earlier: [{ spec: "000-first", id: "FR-009", title: "Export v1", files: ["src/export.ts"], tests: [] }],
};

function payload(links: TraceabilityLinks | null): TraceabilityPayload {
	return {
		spec: "001-orders",
		requirements: [],
		openQuestions: [],
		coverage: {
			applicable: true,
			reason: "",
			percent: 100,
			covered: {},
			uncovered: [],
			unknownRefs: {},
			summary: "",
		},
		links,
	};
}

describe("SpecTraceabilityCard — requirement links", () => {
	beforeEach(() => {
		store.data = null;
	});

	it("shows the untested and the earlier requirements", () => {
		store.data = payload(LINKS);
		render(<SpecTraceabilityCard task={task} projectPath="/p" />);
		expect(screen.getByText('traceability:badge.untested:{"count":1}')).toBeInTheDocument();
		expect(screen.getByText('traceability:badge.earlier:{"count":1}')).toBeInTheDocument();
		fireEvent.click(screen.getByText("traceability:expand"));
		expect(screen.getByText("traceability:links.source.agent-trace")).toBeInTheDocument();
		expect(
			screen.getByText('traceability:links.tests:{"tests":"tests/test_orders.py"}'),
		).toBeInTheDocument();
		expect(
			screen.getByText('traceability:links.noTest:{"files":"src/export.ts"}'),
		).toBeInTheDocument();
		expect(
			screen.getByText('traceability:links.earlier.item:{"spec":"000-first","id":"FR-009"}'),
		).toBeInTheDocument();
	});

	it("stays away when the links have nothing to say", () => {
		store.data = payload({ ...LINKS, requirements: [LINKS.requirements[0]], earlier: [] });
		const { container } = render(<SpecTraceabilityCard task={task} projectPath="/p" />);
		expect(container).toBeEmptyDOMElement();
		store.data = payload(null);
		const again = render(<SpecTraceabilityCard task={task} projectPath="/p" />);
		expect(again.container).toBeEmptyDOMElement();
	});
});

/**
 * @vitest-environment jsdom
 */

/**
 * SchemaGuardCard — what the task's migrations do to a live database.
 *
 * Pinned: no record or no migration, no card; errors come before warnings,
 * each with its statement and the translated advice; the zero-downtime plan
 * shows only when an error calls for it; "Check again" re-reads the task's
 * migrations and shows the result, or the backend's error.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { Task } from "../../../../shared/types";
import type { SchemaGuardRecord } from "../../../lib/agent-tools-api";

const api = vi.hoisted(() => ({
	fetchSchemaGuard: vi.fn(),
	checkSchemaGuard: vi.fn(),
}));

vi.mock("../../../lib/agent-tools-api", () => api);
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
		i18n: { language: "fr" },
	}),
}));

import { SchemaGuardCard } from "../SchemaGuardCard";

const task = { id: "t1", specId: "001-role" } as unknown as Task;

function record(overrides: Partial<SchemaGuardRecord> = {}): SchemaGuardRecord {
	return {
		status: "fail",
		engine: "postgres",
		mode: "warn",
		unchecked: "",
		migrations: [{ path: "db/migrate/1_role.rb", tool: "rails", new: true }],
		findings: [
			{
				kind: "lock",
				severity: "warning",
				path: "db/migrate/1_role.rb",
				line: 4,
				statement: "add_index :users, :role",
				message: "builds an index without CONCURRENTLY",
				advice: "…",
			},
			{
				kind: "not_null",
				severity: "error",
				path: "db/migrate/1_role.rb",
				line: 3,
				statement: "add_column :users, :role, :string, null: false",
				message: "adds a NOT NULL column without a default to an existing table",
				advice: "…",
			},
		],
		plan: ["Expand", "Migrate", "Switch", "Contract"],
		checked_at: 1,
		...overrides,
	};
}

const ok = (value: SchemaGuardRecord | null) => ({ ok: true, data: { record: value } });

describe("SchemaGuardCard", () => {
	beforeEach(() => {
		api.fetchSchemaGuard.mockReset();
		api.checkSchemaGuard.mockReset();
	});

	it("shows nothing without a record or without a migration", async () => {
		api.fetchSchemaGuard.mockResolvedValueOnce(ok(null));
		const { container, rerender } = render(<SchemaGuardCard task={task} projectPath="/p" />);
		await waitFor(() => expect(api.fetchSchemaGuard).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();

		api.fetchSchemaGuard.mockResolvedValueOnce(ok(record({ migrations: [], findings: [] })));
		rerender(<SchemaGuardCard task={{ ...task, specId: "002" } as Task} projectPath="/p" />);
		await waitFor(() => expect(api.fetchSchemaGuard).toHaveBeenCalledTimes(2));
		expect(screen.queryByTestId("schema-guard-card")).not.toBeInTheDocument();
	});

	it("lists errors first with their statement and advice, then the plan", async () => {
		api.fetchSchemaGuard.mockResolvedValue(ok(record()));
		render(<SchemaGuardCard task={task} projectPath="/p" />);

		const items = await screen.findAllByTestId("schema-guard-finding");
		expect(items[0]).toHaveTextContent("tasks:schemaGuard.kind.not_null");
		expect(items[0]).toHaveTextContent("add_column :users, :role, :string, null: false");
		expect(items[0]).toHaveTextContent("tasks:schemaGuard.advice.not_null");
		expect(items[1]).toHaveTextContent("tasks:schemaGuard.kind.lock");
		expect(screen.getByText("tasks:schemaGuard.status.fail")).toBeInTheDocument();
		expect(screen.getByText("tasks:schemaGuard.plan.expand")).toBeInTheDocument();
	});

	it("checks again and shows the new result, or the error", async () => {
		api.fetchSchemaGuard.mockResolvedValue(ok(record()));
		api.checkSchemaGuard.mockResolvedValueOnce(
			ok(record({ status: "pass", findings: [], plan: [] })),
		);
		render(<SchemaGuardCard task={task} projectPath="/p" />);
		fireEvent.click(await screen.findByText("tasks:schemaGuard.check"));

		await waitFor(() =>
			expect(screen.getByText("tasks:schemaGuard.status.pass")).toBeInTheDocument(),
		);
		expect(api.checkSchemaGuard).toHaveBeenCalledWith({ projectDir: "/p", specId: "001-role" });
		expect(screen.queryByTestId("schema-guard-finding")).not.toBeInTheDocument();
		expect(screen.queryByText("tasks:schemaGuard.planTitle")).not.toBeInTheDocument();

		api.checkSchemaGuard.mockResolvedValueOnce({ ok: false, error: "boom" });
		fireEvent.click(screen.getByText("tasks:schemaGuard.check"));
		expect(await screen.findByRole("alert")).toHaveTextContent("boom");
	});
});

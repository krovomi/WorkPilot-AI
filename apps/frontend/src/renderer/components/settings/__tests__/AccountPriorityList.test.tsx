/**
 * AccountPriorityList — the failover chain: every connected account in the
 * order a stopped task moves through them, with its rank, its kind and its
 * usage; a switch takes one out without losing its place.
 */

import type { DragEndEvent } from "@dnd-kit/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { AccountPriorityList } from "../AccountPriorityList";
import type { FailoverAccount } from "../failover-accounts";

// The drop needs a real pointer and layout; the list gets the event dnd-kit sends.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as undefined | ((event: DragEndEvent) => void) }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/core")>();
	return {
		...actual,
		DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
			dnd.onDragEnd = props.onDragEnd;
			return <actual.DndContext {...props} />;
		},
	};
});

// A row being dragged is lifted above the others.
const sortable = vi.hoisted(() => ({ dragging: "" }));
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
	return {
		...actual,
		useSortable: (args: Parameters<typeof actual.useSortable>[0]) => ({
			...actual.useSortable(args),
			isDragging: args.id === sortable.dragging,
		}),
	};
});

const t = (key: string, options?: Record<string, unknown>) => i18n.t(`settings:${key}`, options);

const ACCOUNTS: FailoverAccount[] = [
	{ id: "oauth-me", kind: "oauth", provider: "anthropic", label: "Me", detail: "me@example.com", isActive: true, sessionPercent: 41.6 },
	{ id: "api-proxy", kind: "api", provider: "openai", label: "Proxy", isActive: false },
	{ id: "provider-copilot", kind: "provider", provider: "copilot", label: "GitHub Copilot", detail: "@octo", isActive: false },
];

function renderList(excluded: string[] = [], disabled = false) {
	const onReorder = vi.fn();
	const onInclude = vi.fn();
	render(
		<AccountPriorityList
			accounts={ACCOUNTS}
			excluded={(account) => excluded.includes(account.id)}
			providerLabel={(provider) => provider.toUpperCase()}
			disabled={disabled}
			onReorder={onReorder}
			onInclude={onInclude}
		/>,
	);
	return { onReorder, onInclude };
}

const drop = (active: string, over: string | null) =>
	act(() => dnd.onDragEnd?.({ active: { id: active }, over: over === null ? null : { id: over } } as DragEndEvent));

afterEach(() => {
	cleanup();
	dnd.onDragEnd = undefined;
});

describe("AccountPriorityList", () => {
	it("ranks the accounts in the chain and marks the one taken out", () => {
		renderList(["api-proxy"]);
		const rows = screen.getAllByRole("listitem");
		expect(rows.map((row) => row.querySelector(".wp-mono")?.textContent)).toEqual(["1", "–", "2"]);
		expect(rows[0]).toHaveTextContent(t("aiAccounts.failover.kind.oauth"));
		expect(rows[0]).toHaveTextContent(t("aiAccounts.failover.active"));
		expect(rows[0]).toHaveTextContent(`me@example.com · ${t("aiAccounts.card.usage", { session: 42 })}`);
		expect(rows[1]).toHaveTextContent(t("aiAccounts.failover.kind.api"));
		expect(rows[2]).toHaveTextContent("@octo");
	});

	it("puts an account back in the chain or takes it out", async () => {
		const { onInclude } = renderList(["api-proxy"]);
		await userEvent.click(screen.getByRole("switch", { name: t("aiAccounts.failover.include", { name: "Proxy" }) }));
		await userEvent.click(screen.getByRole("switch", { name: t("aiAccounts.failover.include", { name: "Me" }) }));
		expect(onInclude.mock.calls).toEqual([
			["api-proxy", true],
			["oauth-me", false],
		]);
	});

	it("gives the new order when an account is dropped on another", () => {
		const { onReorder } = renderList();
		drop("provider-copilot", "oauth-me");
		drop("oauth-me", "oauth-me");
		drop("oauth-me", null);
		expect(onReorder.mock.calls).toEqual([[["provider-copilot", "oauth-me", "api-proxy"]]]);
	});

	it("lifts the row being dragged", () => {
		sortable.dragging = "api-proxy";
		renderList();
		expect(screen.getAllByRole("listitem")[1].className).toContain("shadow-lg");
		sortable.dragging = "";
	});

	it("locks the list when disabled", () => {
		renderList([], true);
		for (const handle of screen.getAllByRole("button", { name: /^Move / })) expect(handle).toBeDisabled();
	});
});

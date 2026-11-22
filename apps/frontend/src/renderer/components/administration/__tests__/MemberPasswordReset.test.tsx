/** @vitest-environment jsdom */
/**
 * Members tab: a platform administrator issues a password reset link for an
 * active account; the link is shown to copy only when no email went.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { MembersTab } from "../MembersTab";

const ok = (data: unknown) => Promise.resolve({ ok: true as const, data });
const LINK = `https://wp.example.test/reset-password?token=${"A".repeat(43)}`;

const member = (user_id: string, over = {}) => ({
	user_id,
	email: `${user_id}@example.test`,
	display_name: user_id.toUpperCase(),
	role_id: "r-lead",
	role_slug: "lead",
	role_name: "Lead",
	is_active: true,
	created_at: "2026-11-01T00:00:00Z",
	...over,
});

const serverAdmin = {
	listMembers: vi.fn(),
	listRoles: vi.fn(),
	listSessions: vi.fn(),
};
const issuePasswordReset = vi.fn();
const writeText = vi.fn();

function grant(isPlatformAdmin: boolean): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin,
		orgId: "o1",
		organizations: [],
		permissions: new Set<string>(),
	});
}

beforeEach(() => {
	for (const fn of [...Object.values(serverAdmin), issuePasswordReset, writeText]) fn.mockReset();
	serverAdmin.listMembers.mockImplementation(() =>
		ok([member("ana"), member("bo", { is_active: false })]),
	);
	serverAdmin.listRoles.mockImplementation(() => ok([]));
	serverAdmin.listSessions.mockImplementation(() => ok([]));
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		serverAdmin,
		serverAuth: { issuePasswordReset },
	};
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	writeText.mockResolvedValue(undefined);
	useAdminStore.setState({ members: [], roles: [], sessions: [], loading: {}, error: null });
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

async function rowOf(name: string): Promise<HTMLElement> {
	return (await screen.findByText(`${name}@example.test`)).closest("tr") as HTMLElement;
}

describe("MembersTab password reset", () => {
	it("is offered to a platform administrator only", async () => {
		grant(false);
		render(<MembersTab />);
		await rowOf("ana");
		expect(screen.queryByTitle("Reset password")).toBeNull();
	});

	it("is not offered for a disabled account", async () => {
		grant(true);
		render(<MembersTab />);
		const bo = await rowOf("bo");
		expect(within(bo).queryByTitle("Reset password")).toBeNull();
	});

	it("says the link was emailed", async () => {
		grant(true);
		issuePasswordReset.mockResolvedValue({
			ok: true,
			data: { email: "ana@example.test", expires_at: "2026-11-22T12:00:00Z", email_sent: true, reset_link: null },
		});
		render(<MembersTab />);
		const ana = await rowOf("ana");
		fireEvent.click(within(ana).getByRole("button", { name: "Reset the password of ANA" }));
		expect(await screen.findByRole("status")).toHaveTextContent(
			"A reset link was emailed to ana@example.test.",
		);
		expect(issuePasswordReset).toHaveBeenCalledWith("ana");
	});

	it("shows the link to copy when no email went", async () => {
		grant(true);
		issuePasswordReset.mockResolvedValue({
			ok: true,
			data: { email: "ana@example.test", expires_at: "2026-11-22T12:00:00Z", email_sent: false, reset_link: LINK },
		});
		render(<MembersTab />);
		fireEvent.click(within(await rowOf("ana")).getByTitle("Reset password"));
		expect(await screen.findByText(LINK)).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent("send this link to ana@example.test");
		fireEvent.click(screen.getByRole("button", { name: "Copy the link" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
		expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
	});

	it("says why it failed", async () => {
		grant(true);
		issuePasswordReset.mockResolvedValue({ ok: false, error: "This account has no local password" });
		render(<MembersTab />);
		fireEvent.click(within(await rowOf("ana")).getByTitle("Reset password"));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The reset link could not be issued: This account has no local password",
		);
	});
});

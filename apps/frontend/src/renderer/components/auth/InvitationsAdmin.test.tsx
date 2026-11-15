/** @vitest-environment jsdom */
/**
 * Invitations: an organization administrator invites members and viewers;
 * only a platform administrator is offered a server administrator, the one
 * role the server refuses to anyone else.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { usePermissionsStore } from "@/stores/permissions-store";
import { InvitationsAdmin } from "./InvitationsAdmin";

const serverAuth = {
	listInvites: vi.fn(),
	createInvite: vi.fn(),
	revokeInvite: vi.fn(),
};

function signedInAs(isPlatformAdmin: boolean): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin,
		permissions: new Set(["org.invitation.read", "org.invitation.write"]),
	});
}

beforeEach(() => {
	for (const fn of Object.values(serverAuth)) fn.mockReset();
	serverAuth.listInvites.mockResolvedValue({ ok: true, data: [] });
	(window as unknown as { electronAPI: unknown }).electronAPI = { serverAuth };
});

afterEach(() => {
	cleanup();
});

function roles(): string[] {
	const select = screen.getByLabelText("Role") as HTMLSelectElement;
	return Array.from(select.options).map((option) => option.value);
}

describe("InvitationsAdmin", () => {
	it("offers an organization administrator members and viewers only", async () => {
		signedInAs(false);
		render(<InvitationsAdmin />);
		await waitFor(() => expect(serverAuth.listInvites).toHaveBeenCalled());
		expect(roles()).toEqual(["member", "viewer"]);
		expect(screen.queryByText("Server administrator")).not.toBeInTheDocument();
	});

	it("offers a platform administrator a server administrator too", async () => {
		signedInAs(true);
		render(<InvitationsAdmin />);
		await waitFor(() => expect(serverAuth.listInvites).toHaveBeenCalled());
		expect(roles()).toEqual(["member", "viewer", "admin"]);
		expect(screen.getByRole("option", { name: "Server administrator" })).toBeInTheDocument();
	});

	it("sends the chosen role and shows the link to share", async () => {
		signedInAs(false);
		serverAuth.createInvite.mockResolvedValue({
			ok: true,
			data: { invite_link: "https://team.example/invite?token=t", email_sent: false },
		});
		render(<InvitationsAdmin />);
		fireEvent.change(screen.getByLabelText("New user's email"), {
			target: { value: " dana@example.test " },
		});
		fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
		fireEvent.click(screen.getByRole("button", { name: "Invite" }));
		await waitFor(() =>
			expect(serverAuth.createInvite).toHaveBeenCalledWith({
				email: "dana@example.test",
				role: "viewer",
			}),
		);
		expect(await screen.findByText(/Share this single-use link/)).toBeInTheDocument();
		expect(screen.getByDisplayValue("https://team.example/invite?token=t")).toBeInTheDocument();
	});
});

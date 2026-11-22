/** @vitest-environment jsdom */
/**
 * Invitations: an organization administrator invites members and viewers;
 * only a platform administrator is offered a server administrator, the one
 * role the server refuses to anyone else.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
	vi.useRealTimers();
});

const LINK = "https://team.example/invite?token=fake-token";
const writeText = vi.fn();
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

async function invite(emailSent: boolean): Promise<void> {
	serverAuth.createInvite.mockResolvedValue({
		ok: true,
		data: { invite_link: LINK, email_sent: emailSent },
	});
	render(<InvitationsAdmin />);
	fireEvent.change(screen.getByLabelText("New user's email"), { target: { value: "dana@example.test" } });
	fireEvent.click(screen.getByRole("button", { name: "Invite" }));
	expect(await screen.findByDisplayValue(LINK)).toBeInTheDocument();
}

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
				org_role: null,
			}),
		);
		expect(await screen.findByText(/Share this single-use link/)).toBeInTheDocument();
		expect(screen.getByDisplayValue("https://team.example/invite?token=t")).toBeInTheDocument();
	});

	it("names the role in the organization when the roles can be read", async () => {
		signedInAs(false);
		const listRoles = vi.fn().mockResolvedValue({
			ok: true,
			data: [
				{ id: "r1", slug: "reviewer", name: "Reviewer", scope: "org" },
				{ id: "r2", slug: "proj-only", name: "Project only", scope: "project" },
			],
		});
		(window as unknown as { electronAPI: unknown }).electronAPI = {
			serverAuth,
			serverAdmin: { listRoles },
		};
		serverAuth.createInvite.mockResolvedValue({
			ok: true,
			data: { invite_link: LINK, email_sent: false },
		});
		render(<InvitationsAdmin />);
		const select = (await screen.findByLabelText("Role in the organization")) as HTMLSelectElement;
		// A project-scoped role is no role in the organization.
		expect(Array.from(select.options).map((o) => o.value)).toEqual(["", "reviewer"]);
		fireEvent.change(select, { target: { value: "reviewer" } });
		fireEvent.change(screen.getByLabelText("New user's email"), {
			target: { value: "rita@example.test" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Invite" }));
		await waitFor(() =>
			expect(serverAuth.createInvite).toHaveBeenCalledWith({
				email: "rita@example.test",
				role: "member",
				org_role: "reviewer",
			}),
		);
	});

	it("offers no organization role when the roles cannot be read", async () => {
		signedInAs(false);
		(window as unknown as { electronAPI: unknown }).electronAPI = {
			serverAuth,
			serverAdmin: { listRoles: vi.fn().mockRejectedValue(new Error("403")) },
		};
		render(<InvitationsAdmin />);
		await waitFor(() => expect(serverAuth.listInvites).toHaveBeenCalled());
		expect(screen.queryByLabelText("Role in the organization")).not.toBeInTheDocument();
	});

	it("lists pending invitations with their role in the app's language", async () => {
		signedInAs(false);
		serverAuth.listInvites.mockResolvedValue({
			ok: true,
			data: [
				{ id: "i1", email: "dana@example.test", role: "viewer", expires_at: "2026-11-20T10:00:00Z" },
				{ id: "i2", email: "sam@example.test", role: "auditor", expires_at: "2026-11-21T10:00:00Z" },
			],
		});
		render(<InvitationsAdmin />);
		expect(await screen.findByText("dana@example.test")).toBeInTheDocument();
		expect(screen.getByText(/^Viewer ·/)).toBeInTheDocument();
		expect(screen.getByText(/^auditor ·/)).toBeInTheDocument();
		expect(screen.queryByText("No pending invitations.")).not.toBeInTheDocument();
	});

	it("says no invitation is pending, or why the list could not be read", async () => {
		signedInAs(false);
		render(<InvitationsAdmin />);
		expect(await screen.findByText("No pending invitations.")).toBeInTheDocument();
		cleanup();

		serverAuth.listInvites.mockResolvedValue({ ok: false, error: "Not allowed" });
		render(<InvitationsAdmin />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed");
		cleanup();

		serverAuth.listInvites.mockRejectedValue(new Error("Server unreachable"));
		render(<InvitationsAdmin />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
		cleanup();

		serverAuth.listInvites.mockRejectedValue("refused");
		render(<InvitationsAdmin />);
		expect(await screen.findByRole("alert")).toHaveTextContent("refused");
	});

	it("says when the email went out, clears the field and reads the list again", async () => {
		signedInAs(false);
		await invite(true);
		expect(screen.getByText(/Invitation sent by email/)).toBeInTheDocument();
		expect(screen.getByLabelText("New user's email")).toHaveValue("");
		expect(serverAuth.listInvites).toHaveBeenCalledTimes(2);
		expect(screen.getByRole("button", { name: "Invite" })).toBeDisabled();
	});

	it("disables the button while the invitation is created", async () => {
		signedInAs(false);
		let answer!: (value: unknown) => void;
		serverAuth.createInvite.mockReturnValue(new Promise((r) => (answer = r)));
		render(<InvitationsAdmin />);
		const button = screen.getByRole("button", { name: "Invite" });
		expect(button).toBeDisabled();
		fireEvent.change(screen.getByLabelText("New user's email"), { target: { value: "   " } });
		expect(button).toBeDisabled();
		fireEvent.change(screen.getByLabelText("New user's email"), { target: { value: "dana@example.test" } });
		fireEvent.click(button);
		expect(button).toBeDisabled();
		await act(async () => answer({ ok: false, error: "Already a member" }));
		expect(screen.getByRole("alert")).toHaveTextContent("Already a member");
		expect(button).toBeEnabled();
		expect(screen.getByLabelText("New user's email")).toHaveValue("dana@example.test");

		serverAuth.createInvite.mockRejectedValue(new Error("Main process refused"));
		fireEvent.click(button);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Main process refused"));
		expect(screen.queryByDisplayValue(LINK)).not.toBeInTheDocument();
	});

	it("copies the link, shows it was copied for a moment, and says when it could not", async () => {
		signedInAs(false);
		await invite(false);
		vi.useFakeTimers();
		const copy = screen.getByRole("button", { name: "Copy the link" });
		writeText.mockReset().mockResolvedValue(undefined);
		await act(async () => fireEvent.click(copy));
		expect(writeText).toHaveBeenCalledWith(LINK);
		expect(copy.querySelector(".lucide-check")).not.toBeNull();
		await act(async () => vi.advanceTimersByTime(1000));
		await act(async () => fireEvent.click(copy));
		await act(async () => vi.advanceTimersByTime(1000));
		expect(copy.querySelector(".lucide-check")).not.toBeNull();
		await act(async () => vi.advanceTimersByTime(600));
		expect(copy.querySelector(".lucide-copy")).not.toBeNull();

		writeText.mockRejectedValue(new Error("denied"));
		await act(async () => fireEvent.click(copy));
		expect(screen.getByRole("alert")).toHaveTextContent("The link could not be copied");
		expect(copy.querySelector(".lucide-copy")).not.toBeNull();
	});

	it("stops the copied timer when the view closes", async () => {
		signedInAs(false);
		await invite(false);
		vi.useFakeTimers();
		writeText.mockReset().mockResolvedValue(undefined);
		await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy the link" })));
		expect(vi.getTimerCount()).toBe(1);
		cleanup();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("revokes an invitation, or says why it was not", async () => {
		signedInAs(false);
		serverAuth.listInvites.mockResolvedValue({
			ok: true,
			data: [{ id: "i1", email: "dana@example.test", role: "member", expires_at: "2026-11-20T10:00:00Z" }],
		});
		render(<InvitationsAdmin />);
		const revoke = await screen.findByRole("button", { name: "Revoke" });

		serverAuth.revokeInvite.mockResolvedValueOnce({ ok: true });
		fireEvent.click(revoke);
		await waitFor(() => expect(serverAuth.listInvites).toHaveBeenCalledTimes(2));
		expect(serverAuth.revokeInvite).toHaveBeenCalledWith("i1");

		serverAuth.revokeInvite.mockResolvedValueOnce({ ok: false, error: "Already used" });
		fireEvent.click(revoke);
		expect(await screen.findByRole("alert")).toHaveTextContent("Already used");

		serverAuth.revokeInvite.mockRejectedValueOnce(new Error("Server unreachable"));
		fireEvent.click(revoke);
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server unreachable"));
		expect(serverAuth.listInvites).toHaveBeenCalledTimes(2);
	});
});

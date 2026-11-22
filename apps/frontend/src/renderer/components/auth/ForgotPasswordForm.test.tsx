/** @vitest-environment jsdom */
/**
 * "Forgot password?": ask for a link, then paste it and choose the new
 * password; a server without email sends people to an administrator.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { useServerSessionStore } from "../../stores/server-session-store";
import { ForgotPasswordForm } from "./ForgotPasswordForm";
import { ServerLoginScreen } from "./ServerLoginScreen";

const getConfig = vi.fn();
const requestPasswordReset = vi.fn();
const lookupPasswordReset = vi.fn();
const confirmPasswordReset = vi.fn();
const URL_ = "https://wp.example.test";
const LINK = `${URL_}/reset-password?token=${"A".repeat(43)}`;
const PASSWORD = "a-brand-new-passphrase-42"; // pragma: allowlist secret

function config(byEmail: boolean) {
	return {
		ok: true,
		data: {
			local_enabled: true,
			entra_enabled: false,
			entra_tenant_id: null,
			entra_client_id: null,
			password_reset_by_email: byEmail,
		},
	};
}

beforeEach(() => {
	for (const mock of [getConfig, requestPasswordReset, lookupPasswordReset, confirmPasswordReset]) {
		mock.mockReset();
	}
	localStorage.clear();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		serverAuth: { getConfig, requestPasswordReset, lookupPasswordReset, confirmPasswordReset },
	};
});

afterEach(() => cleanup());

function renderForm(onDone = vi.fn(), onBack = vi.fn()) {
	render(<ForgotPasswordForm serverUrl={URL_} onBack={onBack} onDone={onDone} />);
	return { onDone, onBack };
}

describe("ForgotPasswordForm", () => {
	it("asks for a link and says one is on its way", async () => {
		getConfig.mockResolvedValue(config(true));
		requestPasswordReset.mockResolvedValue({ ok: true, data: { requested: true } });
		renderForm();
		const send = screen.getByRole("button", { name: "Send the link" });
		expect(send).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: " a@example.test " } });
		await waitFor(() => expect(send).toBeEnabled());
		fireEvent.click(send);
		expect(await screen.findByRole("status")).toHaveTextContent("a link is on its way");
		expect(requestPasswordReset).toHaveBeenCalledWith(URL_, "a@example.test");
	});

	it("says why a request failed", async () => {
		getConfig.mockResolvedValue(config(true));
		requestPasswordReset
			.mockResolvedValueOnce({ ok: false, error: "Invalid server address" })
			.mockResolvedValueOnce({ ok: false, error: "" });
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.test" } });
		const send = screen.getByRole("button", { name: "Send the link" });
		await waitFor(() => expect(send).toBeEnabled());
		fireEvent.click(send);
		expect(await screen.findByRole("alert")).toHaveTextContent("Invalid server address");
		fireEvent.click(send);
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("The password could not be reset"),
		);
	});

	it("sends people to an administrator when the server has no email", async () => {
		getConfig.mockResolvedValue(config(false));
		renderForm();
		expect(await screen.findByRole("note")).toHaveTextContent("Ask a server administrator");
		expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send the link" })).toBeDisabled();
	});

	it("an unreachable server still lets people ask", async () => {
		getConfig.mockRejectedValue(new Error("down"));
		renderForm();
		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.test" } });
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Send the link" })).toBeEnabled(),
		);
	});

	it("sets the new password with the pasted link", async () => {
		getConfig.mockResolvedValue({ ok: false, error: "x" });
		lookupPasswordReset.mockResolvedValue({ ok: true, data: { email: "a@example.test" } });
		confirmPasswordReset.mockResolvedValue({ ok: true, data: { reset: true } });
		const { onDone } = renderForm();
		fireEvent.click(screen.getByRole("button", { name: "I have a link" }));
		fireEvent.change(screen.getByLabelText("Reset link or code"), { target: { value: LINK } });
		expect(await screen.findByText("For the account a@example.test")).toBeInTheDocument();
		const save = screen.getByRole("button", { name: "Set my password" });
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "other-passphrase-1" } });
		expect(screen.getByText("The passwords do not match")).toBeInTheDocument();
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
		fireEvent.click(save);
		await waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(confirmPasswordReset).toHaveBeenCalledWith(URL_, LINK, PASSWORD);
	});

	it("says when a link cannot serve, and when saving fails", async () => {
		getConfig.mockResolvedValue(config(true));
		lookupPasswordReset
			.mockResolvedValueOnce({ ok: false, error: "nope" })
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValue({ ok: true, data: { email: "a@example.test" } });
		confirmPasswordReset
			.mockResolvedValueOnce({ ok: false, error: "Password must be at least 12 characters" })
			.mockResolvedValueOnce({ ok: false, error: "" });
		const { onDone } = renderForm();
		fireEvent.click(screen.getByRole("button", { name: "I have a link" }));
		const field = screen.getByLabelText("Reset link or code");
		fireEvent.change(field, { target: { value: LINK } });
		expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
		fireEvent.change(field, { target: { value: `${LINK}B` } });
		await waitFor(() => expect(lookupPasswordReset).toHaveBeenCalledTimes(2));
		fireEvent.change(field, { target: { value: `${LINK}C` } });
		expect(await screen.findByText("For the account a@example.test")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
		fireEvent.click(screen.getByRole("button", { name: "Set my password" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("at least 12 characters");
		fireEvent.click(screen.getByRole("button", { name: "Set my password" }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent("The password could not be reset"),
		);
		expect(onDone).not.toHaveBeenCalled();
		// Back to asking for a link.
		fireEvent.click(screen.getByRole("button", { name: "I need a link" }));
		expect(screen.getByRole("button", { name: "Send the link" })).toBeInTheDocument();
	});

	it("drops an answer about an address or a link that has since changed", async () => {
		let answerConfig: (value: unknown) => void = () => {};
		getConfig
			.mockImplementationOnce(() => new Promise((resolve) => (answerConfig = resolve)))
			.mockResolvedValue(config(false));
		let answerLookup: (value: unknown) => void = () => {};
		lookupPasswordReset
			.mockImplementationOnce(() => new Promise((resolve) => (answerLookup = resolve)))
			.mockResolvedValue({ ok: false, error: "nope" });
		renderForm();
		await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1));
		fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "https://other.example.test" } });
		answerConfig(config(true));
		expect(await screen.findByRole("note")).toHaveTextContent("Ask a server administrator");
		fireEvent.click(screen.getByRole("button", { name: "I have a link" }));
		const field = screen.getByLabelText("Reset link or code");
		fireEvent.change(field, { target: { value: LINK } });
		await waitFor(() => expect(lookupPasswordReset).toHaveBeenCalledTimes(1));
		fireEvent.change(field, { target: { value: `${LINK}B` } });
		answerLookup({ ok: true, data: { email: "stale@example.test" } });
		expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");
		expect(screen.queryByText("For the account stale@example.test")).not.toBeInTheDocument();
	});

	it("goes back to sign-in", () => {
		getConfig.mockResolvedValue(config(true));
		const { onBack } = renderForm();
		fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(onBack).toHaveBeenCalled();
	});
});

describe("ServerLoginScreen forgot password", () => {
	it("opens the form and, once the password is set, says so", async () => {
		getConfig.mockResolvedValue(config(true));
		lookupPasswordReset.mockResolvedValue({ ok: true, data: { email: "a@example.test" } });
		confirmPasswordReset.mockResolvedValue({ ok: true, data: { reset: true } });
		useServerSessionStore.setState({ serverUrl: URL_ });
		render(<ServerLoginScreen />);
		fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
		fireEvent.click(screen.getByRole("button", { name: "I have a link" }));
		fireEvent.change(screen.getByLabelText("Reset link or code"), { target: { value: LINK } });
		await screen.findByText("For the account a@example.test");
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: PASSWORD } });
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: PASSWORD } });
		fireEvent.click(screen.getByRole("button", { name: "Set my password" }));
		expect(
			await screen.findByText("Your password was changed. Sign in with the new one."),
		).toBeInTheDocument();
	});

	it("comes back to sign-in without a change", async () => {
		getConfig.mockResolvedValue(config(true));
		useServerSessionStore.setState({ serverUrl: URL_ });
		render(<ServerLoginScreen />);
		fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
		fireEvent.click(screen.getByRole("button", { name: /Back/ }));
		expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();
	});
});

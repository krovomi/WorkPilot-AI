/**
 * @vitest-environment jsdom
 */
/**
 * The Azure DevOps remote form of a new project: the organization address
 * and the PAT, checked before they are saved.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { AzureDevOpsRemoteConfigModal } from "../AzureDevOpsRemoteConfigModal";

function renderModal(initialConfig?: { orgUrl?: string; pat?: string }) {
	const onSave = vi.fn();
	const onOpenChange = vi.fn();
	render(
		<AzureDevOpsRemoteConfigModal
			open
			onOpenChange={onOpenChange}
			onSave={onSave}
			initialConfig={initialConfig}
		/>,
	);
	return { onSave, onOpenChange };
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("AzureDevOpsRemoteConfigModal", () => {
	it("saves the trimmed address and token, then closes", () => {
		const { onSave, onOpenChange } = renderModal();
		expect(screen.getByRole("dialog", { name: "Set up Azure DevOps" })).toBeInTheDocument();
		const save = screen.getByRole("button", { name: "Confirm" });
		expect(save).toBeDisabled();

		fireEvent.change(screen.getByLabelText("Organization URL"), {
			target: { value: "  https://dev.azure.com/acme  " },
		});
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("PAT token"), {
			target: { value: " fake-pat " },
		});
		fireEvent.click(save);
		expect(onSave).toHaveBeenCalledWith({
			orgUrl: "https://dev.azure.com/acme",
			pat: "fake-pat",
		});
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("hides the token as it is typed", () => {
		renderModal();
		expect(screen.getByLabelText("PAT token")).toHaveAttribute("type", "password");
	});

	it("says at once why an address is refused", () => {
		const { onSave } = renderModal({ pat: "fake-pat" });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		const url = screen.getByLabelText("Organization URL");
		fireEvent.change(url, { target: { value: "http://dev.azure.com/acme" } });
		expect(screen.getByRole("alert")).toHaveTextContent("Invalid Azure DevOps URL.");
		expect(url).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
		expect(onSave).not.toHaveBeenCalled();

		fireEvent.change(url, { target: { value: "https://dev.azure.com/acme" } });
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
	});

	it("starts from a saved configuration", () => {
		renderModal({ orgUrl: "https://dev.azure.com/acme", pat: "fake-pat" });
		expect(screen.getByLabelText("Organization URL")).toHaveValue("https://dev.azure.com/acme");
		expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
	});

	it("closes with its close button, and keeps what was typed on Escape or a click outside", async () => {
		const { onOpenChange } = renderModal();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		// Radix listens for an outside press once the dialog has mounted.
		await new Promise((resolve) => setTimeout(resolve, 0));
		fireEvent.pointerDown(document.body);
		expect(onOpenChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});

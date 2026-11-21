/**
 * @vitest-environment jsdom
 */
/**
 * The one-time notice that asks to sign the Claude profile in again.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { VersionWarningModal } from "../VersionWarningModal";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("VersionWarningModal", () => {
	it("explains how to sign in again", () => {
		render(<VersionWarningModal isOpen onClose={vi.fn()} />);
		expect(screen.getByRole("dialog", { name: "Action Required" })).toHaveAccessibleDescription(
			"Version 2.7.5 Update",
		);
		expect(screen.getByText("To re-authenticate:")).toBeInTheDocument();
		const steps = screen.getAllByRole("listitem");
		expect(steps.map((step) => step.textContent)).toEqual([
			"1Go to Settings",
			"2Navigate to App Settings > Integrations",
			'3Click "Re-authenticate" on your profile',
		]);
	});

	it("is dismissed by Got It and by Escape", () => {
		const onClose = vi.fn();
		const onOpenSettings = vi.fn();
		render(<VersionWarningModal isOpen onClose={onClose} onOpenSettings={onOpenSettings} />);
		fireEvent.click(screen.getByRole("button", { name: "Got It" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onOpenSettings).not.toHaveBeenCalled();
	});

	it("opens the settings when asked", () => {
		const onClose = vi.fn();
		const onOpenSettings = vi.fn();
		render(<VersionWarningModal isOpen onClose={onClose} onOpenSettings={onOpenSettings} />);
		fireEvent.click(screen.getByRole("button", { name: "Go to Settings" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(onOpenSettings).toHaveBeenCalledOnce();
	});

	it("closes when no settings page can be opened", () => {
		const onClose = vi.fn();
		render(<VersionWarningModal isOpen onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Go to Settings" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("shows nothing while closed", () => {
		render(<VersionWarningModal isOpen={false} onClose={vi.fn()} />);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

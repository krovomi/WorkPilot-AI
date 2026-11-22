/** @vitest-environment jsdom */
/**
 * The notification triggers: a memory conflict a teammate's sync queued is
 * announced only when the project switches it on (#352).
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { ProjectEnvConfig } from "../../../../../shared/types";
import { ChannelNotificationsIntegration } from "../ChannelNotificationsIntegration";

const base = { claudeAuthStatus: "not_configured" } as ProjectEnvConfig;

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

afterEach(() => cleanup());

describe("the memory-conflict notice", () => {
	it("is off until the project asks, and the switch says so", () => {
		const update = vi.fn();
		render(<ChannelNotificationsIntegration projectId="p1" envConfig={base} updateEnvConfig={update} />);
		const toggle = screen.getByRole("switch", {
			name: "When a teammate's sync brings a memory that contradicts another one",
		});
		expect(toggle).not.toBeChecked();
		expect(screen.getByText(/never an e-mail/)).toBeInTheDocument();
		fireEvent.click(toggle);
		expect(update).toHaveBeenCalledWith({ memoryConflictNotify: true });
	});

	it("turns off, in French too", async () => {
		await i18n.changeLanguage("fr");
		const update = vi.fn();
		render(
			<ChannelNotificationsIntegration
				projectId="p1"
				envConfig={{ ...base, memoryConflictNotify: true }}
				updateEnvConfig={update}
			/>,
		);
		const toggle = screen.getByRole("switch", {
			name: "Quand la synchronisation d'un coéquipier apporte une mémoire qui en contredit une autre",
		});
		expect(toggle).toBeChecked();
		fireEvent.click(toggle);
		expect(update).toHaveBeenCalledWith({ memoryConflictNotify: false });
	});
});

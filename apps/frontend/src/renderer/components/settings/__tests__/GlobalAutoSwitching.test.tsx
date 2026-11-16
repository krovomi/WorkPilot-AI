/**
 * GlobalAutoSwitching — Settings → AI accounts → Auto failover: the switches
 * the main reads (saved through its own IPC, rolled back when refused), the
 * thresholds of the proactive switch, and the chain kept equal to the
 * connected accounts.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "../../../../__tests__/helpers/renderer-api";
import { callStub, resetStubs, stubModule, stubProps } from "../../../../__tests__/helpers/stub-component";
import i18n from "../../../../shared/i18n";
import type { FailoverAccount } from "../failover-accounts";
import { GlobalAutoSwitching } from "../GlobalAutoSwitching";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("../AccountPriorityList", () => stubModule("AccountPriorityList"));

const t = (key: string) => i18n.t(`settings:${key}`);
const account = (id: string, provider = "anthropic"): FailoverAccount => ({
	id,
	kind: id.startsWith("oauth-") ? "oauth" : "provider",
	provider,
	label: id,
	isActive: false,
});
const ACCOUNTS = [account("oauth-a"), account("oauth-b"), account("provider-copilot", "copilot")];

let api: RendererApi;

function useApi(overrides: Record<string, unknown> = {}) {
	api?.restore();
	api = installRendererApi({
		getAutoSwitchSettings: vi.fn(async () => ({ success: true, data: { enabled: true, autoSwitchOnAuthFailure: false } })),
		getAccountPriorityOrder: vi.fn(async () => ({ success: true, data: ["provider-copilot", "oauth-a", "oauth-b"] })),
		updateAutoSwitchSettings: vi.fn(async () => ({ success: true })),
		setAccountPriorityOrder: vi.fn(async () => ({ success: true })),
		...overrides,
	});
}

function renderSwitching(props: Partial<Parameters<typeof GlobalAutoSwitching>[0]> = {}) {
	const onExcludedChange = vi.fn(async () => true);
	const onSummaryChange = vi.fn();
	const view = render(
		<GlobalAutoSwitching
			accounts={ACCOUNTS}
			excluded={[]}
			onExcludedChange={onExcludedChange}
			providerLabel={(p) => p}
			onSummaryChange={onSummaryChange}
			{...props}
		/>,
	);
	return { onExcludedChange, onSummaryChange, ...view };
}

const order = () => (stubProps("AccountPriorityList").accounts as FailoverAccount[]).map((a) => a.id);
const toggle = (key: string) => screen.getByRole("switch", { name: t(`aiAccounts.failover.${key}`) });

beforeEach(() => useApi());

afterEach(() => {
	cleanup();
	api.restore();
	resetStubs();
	vi.clearAllMocks();
});

describe("GlobalAutoSwitching", () => {
	it("shows the saved switches and the chain in its saved order", async () => {
		const { onSummaryChange } = renderSwitching();
		await waitFor(() => expect(toggle("masterTitle")).toBeChecked());
		expect(screen.getByText(t("aiAccounts.failover.masterOn"))).toBeInTheDocument();
		expect(toggle("rateLimit")).toBeChecked();
		expect(toggle("authFailure")).not.toBeChecked();
		expect(order()).toEqual(["provider-copilot", "oauth-a", "oauth-b"]);
		expect(onSummaryChange).toHaveBeenLastCalledWith({ enabled: true, chainLength: 3 });
		expect(api.fn("setAccountPriorityOrder")).not.toHaveBeenCalled();
	});

	it("saves a switch through the main, and rolls it back when refused", async () => {
		const user = userEvent.setup();
		renderSwitching();
		await waitFor(() => expect(toggle("authFailure")).not.toBeDisabled());
		await user.click(toggle("authFailure"));
		expect(api.fn("updateAutoSwitchSettings")).toHaveBeenCalledWith({ autoSwitchOnAuthFailure: true });
		await user.click(toggle("rateLimit"));
		expect(api.fn("updateAutoSwitchSettings")).toHaveBeenCalledWith({ autoSwitchOnRateLimit: false });
		await waitFor(() => expect(toggle("authFailure")).toBeChecked());

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.fn("updateAutoSwitchSettings").mockResolvedValueOnce({ success: false, error: "no" });
		await user.click(toggle("masterTitle"));
		await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
		expect(toggle("masterTitle")).toBeChecked();
		error.mockRestore();
	});

	it("sets the thresholds of the proactive switch once released", async () => {
		const user = userEvent.setup();
		renderSwitching();
		await waitFor(() => expect(toggle("proactive")).not.toBeDisabled());
		await user.click(toggle("proactive"));
		const session = await screen.findByLabelText(t("aiAccounts.failover.session"));
		fireEvent.change(session, { target: { value: "80" } });
		expect(screen.getByText("80%")).toBeInTheDocument();
		fireEvent.pointerUp(session);
		expect(api.fn("updateAutoSwitchSettings")).toHaveBeenLastCalledWith({ sessionThreshold: 80 });
		fireEvent.blur(session);
		expect(api.fn("updateAutoSwitchSettings")).toHaveBeenCalledTimes(2);
		const weekly = screen.getByLabelText(t("aiAccounts.failover.weekly"));
		fireEvent.change(weekly, { target: { value: "90" } });
		fireEvent.keyUp(weekly);
		await waitFor(() => expect(api.fn("updateAutoSwitchSettings")).toHaveBeenLastCalledWith({ weeklyThreshold: 90 }));
	});

	it("keeps the saved chain equal to the accounts shown", async () => {
		const { rerender } = renderSwitching();
		await waitFor(() => expect(order()).toHaveLength(3));
		rerender(
			<GlobalAutoSwitching
				accounts={[...ACCOUNTS, account("provider-openai", "openai")]}
				excluded={[]}
				onExcludedChange={vi.fn()}
				providerLabel={(p) => p}
			/>,
		);
		await waitFor(() =>
			expect(api.fn("setAccountPriorityOrder")).toHaveBeenCalledWith([
				"provider-copilot",
				"oauth-a",
				"oauth-b",
				"provider-openai",
			]),
		);
	});

	it("logs a chain it could not keep in step", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		useApi({
			getAccountPriorityOrder: vi.fn(async () => ({ success: false })),
			setAccountPriorityOrder: vi.fn(async () => Promise.reject(new Error("disk"))),
		});
		renderSwitching();
		await waitFor(() => expect(error).toHaveBeenCalledWith("[GlobalAutoSwitching] Failed to save the failover chain:", expect.any(Error)));
		error.mockRestore();
	});

	it("saves a new order, and rolls it back when refused", async () => {
		renderSwitching();
		await waitFor(() => expect(order()).toHaveLength(3));
		await act(async () => callStub("AccountPriorityList", "onReorder", ["oauth-a", "oauth-b", "provider-copilot"]));
		expect(order()).toEqual(["oauth-a", "oauth-b", "provider-copilot"]);

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.fn("setAccountPriorityOrder").mockResolvedValueOnce({ success: false, error: "no" });
		await act(async () => callStub("AccountPriorityList", "onReorder", ["oauth-b", "oauth-a", "provider-copilot"]));
		await waitFor(() => expect(order()).toEqual(["oauth-a", "oauth-b", "provider-copilot"]));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("aiAccounts.failover.orderError") }));
		error.mockRestore();
	});

	it("takes an account out of the chain and puts it back, older provider names included", async () => {
		const { onExcludedChange } = renderSwitching({ excluded: ["copilot", "oauth-b"] });
		await waitFor(() => expect(order()).toHaveLength(3));
		const excluded = stubProps("AccountPriorityList").excluded as (a: FailoverAccount) => boolean;
		expect(ACCOUNTS.map(excluded)).toEqual([false, true, true]);
		expect(screen.getByText(t("aiAccounts.failover.chainSingle"))).toBeInTheDocument();

		await act(async () => callStub("AccountPriorityList", "onInclude", "provider-copilot", true));
		expect(onExcludedChange).toHaveBeenLastCalledWith(["oauth-b"]);
		await act(async () => callStub("AccountPriorityList", "onInclude", "oauth-a", false));
		expect(onExcludedChange).toHaveBeenLastCalledWith(["copilot", "oauth-b", "oauth-a"]);
		await act(async () => callStub("AccountPriorityList", "onInclude", "gone", true));
		expect(onExcludedChange).toHaveBeenLastCalledWith(["copilot", "oauth-b"]);

		onExcludedChange.mockResolvedValueOnce(false);
		await act(async () => callStub("AccountPriorityList", "onInclude", "oauth-b", true));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: t("aiAccounts.failover.saveError") }));
	});

	it("says when no account is connected, and starts from the defaults when the main does not answer", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		useApi({ getAutoSwitchSettings: vi.fn(async () => Promise.reject(new Error("down"))) });
		renderSwitching({ accounts: [] });
		await screen.findByText(t("aiAccounts.failover.chainEmpty"));
		expect(toggle("masterTitle")).not.toBeChecked();
		expect(screen.getByText(t("aiAccounts.failover.masterOff"))).toBeInTheDocument();
		error.mockRestore();
	});

	it("reads defaults when the main answers without settings or with a broken order", async () => {
		useApi({
			getAutoSwitchSettings: vi.fn(async () => ({ success: false })),
			getAccountPriorityOrder: vi.fn(async () => ({ success: true, data: "oauth-a" })),
		});
		const { unmount } = renderSwitching();
		await waitFor(() => expect(toggle("rateLimit")).toBeChecked());
		unmount();
	});

	it("ignores an answer that comes after it closed", async () => {
		let answer!: (value: unknown) => void;
		useApi({ getAutoSwitchSettings: vi.fn(() => new Promise((resolve) => (answer = resolve))) });
		const { unmount, container } = renderSwitching();
		unmount();
		await act(async () => answer({ success: true, data: {} }));
		expect(container.innerHTML).toBe("");
	});

	it("ignores a failure that comes after it closed", async () => {
		let fail!: (error: Error) => void;
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		useApi({ getAutoSwitchSettings: vi.fn(() => new Promise((_, reject) => (fail = reject))) });
		const { unmount } = renderSwitching();
		unmount();
		await act(async () => fail(new Error("late")));
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});

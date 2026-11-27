import { fireEvent, screen, waitFor, within } from "expo-router/testing-library";
import { Alert } from "react-native";
import { fakeServer, openApp, reply, restoreFetch } from "../../../test-support/fake-server";

jest.mock("expo-crypto", () => ({ randomUUID: () => "0123abcd-4567-89ef-0123-456789abcdef" }));

const MASK = "********";
const OVERVIEW = {
	available: true,
	vault: true,
	locale: "en",
	events: { plan_review: true, review_ready: true, failed: false, approval_escalated: true, review_feedback_held: true },
	channels: {
		ntfy: {
			configured: true,
			enabled: true,
			readable: true,
			server: "https://ntfy.example.com",
			topic: MASK,
			access_token: null,
		},
		telegram: { configured: false },
		teams: { configured: true, enabled: true, readable: false, webhook_url: MASK },
	},
};
const WRITER = ["board.read", "agent.execute"];

afterEach(() => {
	restoreFetch();
	jest.restoreAllMocks();
});

/** The card of one channel, found by its header. */
function channel(name: string) {
	let node = screen.getByRole("header", { name });
	while (node.parent && !within(node.parent).queryAllByRole("button").length) node = node.parent;
	return within(node.parent ?? node);
}

describe("notify me elsewhere", () => {
	it("opens from the settings", async () => {
		fakeServer({ "GET /users/me/needs-you": OVERVIEW }, WRITER);
		const app = await openApp("/settings");
		await fireEvent.press(await screen.findByRole("button", { name: "Notify me elsewhere" }));
		await waitFor(() => expect(app.getPathname()).toBe("/needs-you"));
		expect(await screen.findByRole("header", { name: "ntfy" })).toBeTruthy();
	});

	it("shows each channel's state and saves the moments and the language at once", async () => {
		const server = fakeServer(
			{ "GET /users/me/needs-you": OVERVIEW, "PUT /users/me/needs-you/preferences": { saved: true } },
			WRITER,
		);
		await openApp("/needs-you");
		expect(await screen.findByText("On")).toBeTruthy();
		expect(screen.getByText("Not set")).toBeTruthy();
		expect(screen.getByText("Set again")).toBeTruthy();
		expect(screen.queryByText(/does not send them yet/)).toBeNull();

		const failed = screen.getByRole("switch", { name: "A task I started stopped on an error" });
		expect(failed.props.value).toBe(false);
		await fireEvent(failed, "valueChange", true);
		await waitFor(() => expect(server.called("PUT /users/me/needs-you/preferences")).toHaveLength(1));
		expect(server.called("PUT /users/me/needs-you/preferences")[0].body).toEqual({
			events: { plan_review: true, review_ready: true, failed: true, approval_escalated: true, review_feedback_held: true },
			locale: "en",
		});
		await fireEvent.press(screen.getByRole("radio", { name: "English" }));
		expect(server.called("PUT /users/me/needs-you/preferences")).toHaveLength(1);
		await fireEvent.press(screen.getByRole("radio", { name: "Français" }));
		await waitFor(() => expect(server.called("PUT /users/me/needs-you/preferences")).toHaveLength(2));
		expect(server.called("PUT /users/me/needs-you/preferences")[1].body).toMatchObject({ locale: "fr" });
	});

	it("puts a moment back when the server refuses it", async () => {
		fakeServer(
			{
				"GET /users/me/needs-you": OVERVIEW,
				"PUT /users/me/needs-you/preferences": reply(400, { detail: "Unknown moment" }),
			},
			WRITER,
		);
		await openApp("/needs-you");
		const plan = await screen.findByRole("switch", { name: "A plan waits for my approval" });
		await fireEvent(plan, "valueChange", false);
		expect(await screen.findByText(/Unknown moment/)).toBeTruthy();
		expect(screen.getByRole("switch", { name: "A plan waits for my approval" }).props.value).toBe(true);
	});

	it("pauses a channel keeping its server, changes it keeping its secret, tests and removes it", async () => {
		const server = fakeServer(
			{
				"GET /users/me/needs-you": OVERVIEW,
				"PUT /users/me/needs-you/channels/ntfy": { saved: true },
				"POST /users/me/needs-you/channels/ntfy/test": { result: "sent" },
				"DELETE /users/me/needs-you/channels/ntfy": { deleted: true },
			},
			WRITER,
		);
		await openApp("/needs-you");
		await fireEvent(await screen.findByRole("switch", { name: "Send on ntfy" }), "valueChange", false);
		await waitFor(() => expect(server.called("PUT /users/me/needs-you/channels/ntfy")).toHaveLength(1));
		expect(server.called("PUT /users/me/needs-you/channels/ntfy")[0].body).toEqual({
			enabled: false,
			server: "https://ntfy.example.com",
		});

		const ntfy = channel("ntfy");
		await fireEvent.press(ntfy.getByRole("button", { name: "Change" }));
		expect(screen.getByLabelText("Server (https)").props.value).toBe("https://ntfy.example.com");
		expect(screen.getByLabelText("Topic").props.placeholder).toBe("Set: leave empty to keep it");
		await fireEvent.changeText(screen.getByLabelText("Access token (optional)"), " tk_abc ");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(server.called("PUT /users/me/needs-you/channels/ntfy")).toHaveLength(2));
		// The topic left empty is not sent: the server keeps it.
		expect(server.called("PUT /users/me/needs-you/channels/ntfy")[1].body).toEqual({
			enabled: true,
			server: "https://ntfy.example.com",
			access_token: "tk_abc",
		});

		await fireEvent.press(await screen.findByRole("button", { name: "Send a test" }));
		expect(await screen.findByText("Test sent. Check ntfy.")).toBeTruthy();

		jest.spyOn(Alert, "alert").mockImplementation((_title, _body, buttons) => buttons?.[1]?.onPress?.());
		await fireEvent.press(channel("ntfy").getByRole("button", { name: "Remove" }));
		await waitFor(() => expect(server.called("DELETE /users/me/needs-you/channels/ntfy")).toHaveLength(1));
	});

	it("sets up a channel only once its fields are there, a generated topic included, and shows a refusal", async () => {
		const server = fakeServer(
			{
				"GET /users/me/needs-you": { ...OVERVIEW, channels: {} },
				"PUT /users/me/needs-you/channels/telegram": reply(400, { detail: "Invalid Telegram bot token" }),
				"PUT /users/me/needs-you/channels/ntfy": { saved: true },
			},
			WRITER,
		);
		await openApp("/needs-you");
		await fireEvent.press(within(await findChannel("Telegram")).getByRole("button", { name: "Set up" }));
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();
		await fireEvent.changeText(screen.getByLabelText("Bot token"), "123:abc");
		await fireEvent.changeText(screen.getByLabelText("Your user id"), "42");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		expect(await screen.findByText(/Invalid Telegram bot token/)).toBeTruthy();
		expect(server.called("PUT /users/me/needs-you/channels/telegram")[0].body).toEqual({
			enabled: true,
			bot_token: "123:abc",
			chat_id: "42",
		});
		await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));

		await fireEvent.press(within(await findChannel("ntfy")).getByRole("button", { name: "Set up" }));
		await fireEvent.press(screen.getByRole("button", { name: "Generate a topic" }));
		expect(screen.getByLabelText("Topic").props.value).toBe("workpilot-0123abcd456789ef0123");
		await fireEvent.press(screen.getByRole("button", { name: "Save" }));
		await waitFor(() => expect(server.called("PUT /users/me/needs-you/channels/ntfy")).toHaveLength(1));
		expect(server.called("PUT /users/me/needs-you/channels/ntfy")[0].body).toEqual({
			enabled: true,
			topic: "workpilot-0123abcd456789ef0123",
		});
	});

	it("says why nothing can be set: sending off, no secrets key, a role that cannot", async () => {
		fakeServer({ "GET /users/me/needs-you": { ...OVERVIEW, available: false, vault: false } }, ["board.read"]);
		await openApp("/needs-you");
		expect(await screen.findByText(/does not send them yet/)).toBeTruthy();
		expect(screen.getByText(/no secrets key/)).toBeTruthy();
		expect(screen.getByText(/Your role cannot set a channel/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Set up" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
		expect(screen.queryByRole("switch", { name: "Send on ntfy" })).toBeNull();
		// Removing one's own channel needs no more than reading.
		expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
	});

	it("shows a paused channel, and a failed load", async () => {
		fakeServer(
			{ "GET /users/me/needs-you": { ...OVERVIEW, channels: { telegram: { configured: true, enabled: false, readable: true, bot_token: MASK, chat_id: "42" } } } },
			WRITER,
		);
		await openApp("/needs-you");
		expect(await screen.findByText("Paused")).toBeTruthy();
		restoreFetch();
		fakeServer({ "GET /users/me/needs-you": reply(500, { detail: "database down" }) }, WRITER);
		await openApp("/needs-you");
		expect(await screen.findByText(/database down/)).toBeTruthy();
		expect(screen.queryByRole("header", { name: "ntfy" })).toBeNull();
	});

	it("explains a test that did not go out", async () => {
		fakeServer(
			{
				"GET /users/me/needs-you": OVERVIEW,
				"POST /users/me/needs-you/channels/ntfy/test": { result: "unreachable" },
			},
			WRITER,
		);
		await openApp("/needs-you");
		await fireEvent.press(await screen.findByRole("button", { name: "Send a test" }));
		expect(await screen.findByText("Not sent: ntfy could not be reached.")).toBeTruthy();
	});
});

async function findChannel(name: string) {
	await screen.findByRole("header", { name });
	let node = screen.getByRole("header", { name });
	while (node.parent && !within(node.parent).queryAllByRole("button").length) node = node.parent;
	return node.parent ?? node;
}

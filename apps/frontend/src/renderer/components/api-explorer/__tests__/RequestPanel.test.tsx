/**
 * The request panel of the API Explorer: the parameters and headers that
 * build the request, how each kind of authentication is sent, the response
 * views, saving a token to the environment, and the request's secrets.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	DEFAULT_REQUEST_AUTH,
	type OpenApiOperation,
	type OpenApiSpec,
	type RequestAuth,
	useApiExplorerStore,
} from "../../../stores/api-explorer-store";
import { useProjectStore } from "../../../stores/project-store";
import { RequestPanel } from "../RequestPanel";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`apiExplorer:${key}`, options ?? {});

const SPEC: OpenApiSpec = { openapi: "3.0.0", info: { title: "Shop", version: "1" }, paths: {} };

const OP: OpenApiOperation = {
	description: "Updates a user.",
	parameters: [
		{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "User id" },
		{ name: "expand", in: "query", example: "teams" },
		{ name: "X-Tenant", in: "header", description: "Tenant" },
	],
	requestBody: { content: { "application/json": { example: { name: "Ada" } } } },
	responses: {
		"200": {
			description: "Updated",
			content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } } } } },
		},
		"404": {},
	},
};

const api = {
	proxyHttpRequest: vi.fn(),
	loadApiExplorerSecrets: vi.fn(),
	saveApiExplorerSecrets: vi.fn(),
};
const initial = useApiExplorerStore.getState();
const onOpenEnvManager = vi.fn();

beforeEach(() => {
	vi.resetAllMocks();
	api.loadApiExplorerSecrets.mockResolvedValue({ success: true, data: {} });
	api.saveApiExplorerSecrets.mockResolvedValue({ success: true });
	api.proxyHttpRequest.mockResolvedValue({ success: true, status: 200, statusText: "OK", headers: {}, body: "", time: 5 });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	useApiExplorerStore.setState(initial, true);
	useApiExplorerStore.setState({
		environments: [
			{ id: "local", name: "Local", baseUrl: "http://api.test", headers: { "X-Env": "1", "X-Empty": "" } },
		],
		activeEnvironmentId: "local",
		activeProjectId: "p1",
		selectedEndpointKey: "PUT:/users/{id}",
	});
	useProjectStore.setState({ activeProjectId: "p1", selectedProjectId: null });
});

afterEach(() => {
	delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI;
});

const setup = async (props: Partial<Parameters<typeof RequestPanel>[0]> = {}) => {
	const view = render(
		<RequestPanel
			method="put"
			path="/users/{id}"
			operation={OP}
			spec={SPEC}
			onOpenEnvManager={onOpenEnvManager}
			{...props}
		/>,
	);
	await act(() => Promise.resolve());
	return { ...view, user: userEvent.setup() };
};
const tab = (label: RegExp | string) => screen.getByRole("button", { name: label });
const send = () => screen.getByRole("button", { name: t("request.send") });
const sent = () => api.proxyHttpRequest.mock.calls.at(-1)?.[0];
const withAuth = (auth: Partial<RequestAuth>) =>
	act(() => useApiExplorerStore.getState().setRequestAuth({ ...DEFAULT_REQUEST_AUTH, ...auth }));
const respond = (response: Record<string, unknown>) =>
	act(() =>
		useApiExplorerStore.getState().setResponse({ status: 200, statusText: "OK", headers: {}, body: "", time: 12, ...response } as never),
	);

describe("RequestPanel parameters", () => {
	it("builds the address from the path, the query and custom rows", async () => {
		const { user } = await setup();
		expect(tab(`${t("request.params")} (2)`)).toBeInTheDocument();
		expect(screen.getByText(t("request.pathParams"))).toBeInTheDocument();

		await user.type(screen.getByPlaceholderText("User id"), "z");
		await user.clear(screen.getByPlaceholderText("User id"));
		expect(screen.getByText("http://api.test/users/{id}")).toBeInTheDocument();
		await user.type(screen.getByPlaceholderText("User id"), "a b");
		await user.type(screen.getByPlaceholderText("teams"), "x");
		expect(screen.getByText("http://api.test/users/a%20b?expand=x")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: t("request.addParam") }));
		await user.click(screen.getByRole("button", { name: t("request.addParam") }));
		const [key] = screen.getAllByPlaceholderText(t("request.paramKey"));
		const [value] = screen.getAllByPlaceholderText(t("request.paramValue"));
		await user.type(key, "page");
		await user.type(value, "2");
		expect(screen.getByText("http://api.test/users/a%20b?expand=x&page=2")).toBeInTheDocument();

		await user.click(screen.getByRole("checkbox", { name: `${t("aria.useRow")} page` }));
		expect(screen.getByText("http://api.test/users/a%20b?expand=x")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: `${t("aria.removeRow")} page` }));
		expect(screen.getAllByPlaceholderText(t("request.paramKey"))).toHaveLength(1);
	});

	it("sends the environment's, the contract's and the added headers, with the body", async () => {
		api.proxyHttpRequest.mockResolvedValue({ success: true, status: 201, statusText: "Created", headers: {}, body: "{}", time: 7 });
		const { user } = await setup();

		await user.type(screen.getByPlaceholderText("User id"), "7");
		await user.click(tab(`${t("request.headers")} (1)`));
		await user.type(screen.getByPlaceholderText("Tenant"), "acme");
		await user.click(screen.getByRole("button", { name: t("request.addHeader") }));
		await user.click(screen.getByRole("button", { name: t("request.addHeader") }));
		await user.type(screen.getAllByPlaceholderText(t("request.headerKey"))[1], "X-Row");
		await user.type(screen.getAllByPlaceholderText(t("request.headerValue"))[1], "r");
		await user.click(screen.getAllByRole("button", { name: t("aria.removeRow") })[0]);
		await user.click(screen.getAllByRole("checkbox")[0]);
		await user.click(screen.getAllByRole("checkbox")[0]);

		await user.click(tab(t("request.body")));
		await user.click(screen.getByRole("button", { name: t("request.fillExample") }));
		expect(screen.getByRole("textbox")).toHaveValue('{\n  "name": "Ada"\n}');
		await user.click(send());

		expect(sent()).toEqual({
			url: "http://api.test/users/7",
			method: "PUT",
			headers: { "X-Env": "1", "X-Tenant": "acme", "X-Row": "r", "Content-Type": "application/json" },
			body: '{\n  "name": "Ada"\n}',
		});
		expect(await screen.findByText("201 Created")).toBeInTheDocument();
		expect(screen.getByText("7ms")).toBeInTheDocument();
	});

	it("offers no body for a GET, and fills nothing without an example", async () => {
		const { user } = await setup({ method: "get", operation: { requestBody: { content: {} } } });
		expect(screen.queryByRole("button", { name: t("request.body") })).not.toBeInTheDocument();
		await user.click(send());
		expect(sent()).toMatchObject({ method: "GET", body: undefined, headers: { "X-Env": "1" } });
	});

	it("sends without an environment, and a body without content types", async () => {
		useApiExplorerStore.setState({ environments: [] });
		const { user } = await setup({ operation: { requestBody: {} as never } });
		await user.click(tab(t("detail.docs")));
		expect(screen.queryByText(t("detail.requestBody"))).not.toBeInTheDocument();
		await user.click(send());
		expect(sent()).toEqual({ url: "/users/{id}", method: "PUT", headers: {}, body: undefined });
	});

	it("keeps the body empty when the example is an empty object", async () => {
		const { user } = await setup({ operation: { requestBody: { content: { "text/plain": {} } } } });
		await user.click(tab(t("request.body")));
		await user.click(screen.getByRole("button", { name: t("request.fillExample") }));
		expect(screen.getByRole("textbox")).toHaveValue("");
		await user.type(screen.getByRole("textbox"), "x");
		await user.click(send());
		expect(sent()).toMatchObject({ body: "x", headers: { "Content-Type": "application/json" } });
	});
});

describe("RequestPanel authentication", () => {
	it.each<[string, Partial<RequestAuth>, Record<string, string>, string?]>([
		["a bearer token", { type: "bearer", bearer: "test-bearer-0000" }, { Authorization: "Bearer test-bearer-0000" }],
		["Basic credentials, in UTF-8", { type: "basic", username: "émile", password: "€" }, { Authorization: `Basic ${btoa("Ã©mile:â\u0082¬")}` }],
		["an API key in a header", { type: "apikey", keyName: "X-Key", keyValue: "k" }, { "X-Key": "k" }],
		["an API key in the query", { type: "apikey", keyName: "api key", keyValue: "k&1", keyLocation: "query" }, {}, "http://api.test/users/{id}?api%20key=k%261"],
		["an OAuth 2.0 token with its prefix", { type: "oauth2", oauth2AccessToken: "at", oauth2HeaderPrefix: "Token" }, { Authorization: "Token at" }],
		["an OAuth 2.0 token, Bearer by default", { type: "oauth2", oauth2AccessToken: "at", oauth2HeaderPrefix: "" }, { Authorization: "Bearer at" }],
		["nothing", { type: "none", bearer: "unused" }, {}],
		["nothing for an empty bearer", { type: "bearer", bearer: "" }, {}],
		["nothing for Basic without credentials", { type: "basic" }, {}],
		["nothing for an API key without a value", { type: "apikey", keyValue: "" }, {}],
		["nothing for OAuth 2.0 without a token", { type: "oauth2" }, {}],
		["nothing to inherit", { type: "inherited" }, {}],
	])("sends %s", async (_label, auth, headers, url = "http://api.test/users/{id}") => {
		const { user } = await setup({ method: "get" });
		withAuth(auth);
		await user.click(send());
		expect(sent()).toEqual({ url, method: "GET", headers: { "X-Env": "1", ...headers }, body: undefined });
	});

	it("inherits the environment's token unless the request sets Authorization", async () => {
		useApiExplorerStore.getState().updateEnvironment("local", { token: "test-env-0000" });
		const op: OpenApiOperation = { parameters: [{ name: "authorization", in: "header" }] };
		const { user } = await setup({ method: "get", operation: op });
		await user.click(send());
		expect(sent().headers.Authorization).toBe("Bearer test-env-0000");

		await user.click(tab(`${t("request.headers")} (1)`));
		await user.type(screen.getByRole("textbox"), "Custom x");
		await user.click(send());
		expect(sent().headers).toEqual({ "X-Env": "1", authorization: "Custom x" });
	});

	it("appends an API key to a query that already has one", async () => {
		const { user } = await setup({ method: "get" });
		withAuth({ type: "apikey", keyName: "k", keyValue: "v", keyLocation: "query" });
		await user.type(screen.getByPlaceholderText("teams"), "x");
		await user.click(send());
		expect(sent().url).toBe("http://api.test/users/{id}?expand=x&k=v");
	});
});

describe("RequestPanel sending", () => {
	it("says OK, or a network error, when the answer has no status text", async () => {
		const { user } = await setup({ method: "get" });
		api.proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 204 });
		await user.click(send());
		expect(await screen.findByText("204 OK")).toBeInTheDocument();

		api.proxyHttpRequest.mockResolvedValueOnce({ success: false, error: "Refused by the main" });
		await user.click(send());
		expect(await screen.findByText(`0 ${t("request.networkError")}`)).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: t("response.format.raw") }));
		expect(screen.getByText("Refused by the main")).toBeInTheDocument();
	});

	it("shows a failed request as a network error, and ends the sending", async () => {
		const { user } = await setup({ method: "get" });
		api.proxyHttpRequest.mockRejectedValueOnce(new Error("offline"));
		await user.click(send());
		expect(await screen.findByText(`0 ${t("request.networkError")}`)).toBeInTheDocument();
		expect(useApiExplorerStore.getState().isSendingRequest).toBe(false);
	});

	it("ends the sending when the request cannot even be built", async () => {
		const { user } = await setup({ method: "get" });
		withAuth({ type: "apikey", keyName: "k", keyValue: "\uD800", keyLocation: "query" });
		await user.click(send());
		expect(api.proxyHttpRequest).not.toHaveBeenCalled();
		expect(useApiExplorerStore.getState()).toMatchObject({ isSendingRequest: false, responseStatus: 0 });
		expect(send()).toBeEnabled();
	});

	it("shows the request on its way", async () => {
		api.proxyHttpRequest.mockReturnValue(new Promise(() => undefined));
		const { user } = await setup({ method: "get" });
		await user.click(send());
		expect(screen.getByText(t("request.sending"))).toBeInTheDocument();
		expect(send()).toBeDisabled();
	});
});

describe("RequestPanel response", () => {
	it("shows JSON pretty, raw, and the headers, with its size", async () => {
		await setup();
		respond({ headers: { "content-type": "application/json" }, body: '{"a":1}' });
		const user = userEvent.setup();

		expect(screen.getByText("0.0 KB", { exact: false })).toBeInTheDocument();
		expect(document.querySelector("pre")?.innerHTML).toContain('<span style="color:#d19a66">1</span>');
		await user.click(screen.getByRole("button", { name: t("response.format.raw") }));
		expect(screen.getByText('{"a":1}')).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: t("response.headers") }));
		expect(screen.getByText("content-type:")).toBeInTheDocument();
		expect(screen.getByText("application/json")).toBeInTheDocument();
	});

	it("previews HTML in a sandboxed frame, and shows it as code on request", async () => {
		await setup();
		respond({ headers: { "Content-Type": "text/html" }, body: "<p>hi</p>" });
		const user = userEvent.setup();

		const frame = screen.getByTitle(t("response.format.preview"));
		expect(frame).toHaveAttribute("sandbox", "");
		await user.click(screen.getByRole("button", { name: t("response.format.pretty") }));
		expect(screen.getByText("<p>hi</p>")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: t("response.format.preview") }));
		expect(screen.getByTitle(t("response.format.preview"))).toBeInTheDocument();
	});

	it("renders in the language picked, and warns when the body is not in it", async () => {
		await setup();
		respond({ headers: {}, body: "plain words" });
		const user = userEvent.setup();
		const language = () => screen.getByTitle(t("response.format.languageTitle"));

		expect(screen.getByText("plain words")).toBeInTheDocument();
		await user.click(language());
		expect(language()).toHaveAttribute("aria-expanded", "true");
		await user.click(screen.getByRole("button", { name: t("response.format.lang.json") }));
		expect(screen.getByText(t("response.format.mismatch", { format: "JSON" }))).toBeInTheDocument();

		await user.click(language());
		await user.click(screen.getByRole("button", { name: t("response.format.lang.xml") }));
		expect(screen.getByText(t("response.format.mismatch", { format: "XML" }))).toBeInTheDocument();

		await user.click(language());
		await user.click(screen.getByRole("button", { name: t("response.format.lang.text") }));
		expect(screen.queryByText(/cannot be parsed|ne peut pas/)).not.toBeInTheDocument();

		await user.click(language());
		await user.click(language());
		expect(language()).toHaveAttribute("aria-expanded", "false");
		await user.click(language());
		await user.click(document.body);
		expect(language()).toHaveAttribute("aria-expanded", "false");
	});

	it("indents an XML answer, and picks the language from its type", async () => {
		await setup();
		respond({ headers: { "content-type": "application/xml" }, body: "<a><b>1</b></a>" });
		expect(screen.getByText("<a> <b>1</b> </a>", { normalizer: (s) => s.replace(/\s+/g, " ").trim() })).toBeInTheDocument();
		respond({ headers: { "content-type": "image/svg+xml" }, body: "<svg/>" });
		expect(screen.getByText("<svg/>")).toBeInTheDocument();
		respond({ headers: { "content-type": "application/json" }, body: "not json" });
		expect(screen.getByText("not json")).toBeInTheDocument();
		expect(screen.queryByText(t("response.format.mismatch", { format: "JSON" }))).not.toBeInTheDocument();
	});

	it("saves a token from the answer to the environment, then says so for a moment", async () => {
		vi.useFakeTimers();
		try {
			await setup();
			respond({ body: '{"access_token":"test-token-123456"}' });
			act(() => screen.getByRole("button", { name: t("response.saveToken") }).click());

			expect(useApiExplorerStore.getState().environments[0].token).toBe("test-token-123456");
			expect(useApiExplorerStore.getState().requestAuth.type).toBe("inherited");
			expect(screen.getByText(t("response.tokenSaved"))).toBeInTheDocument();
			act(() => vi.advanceTimersByTime(2500));
			expect(screen.getByText(t("response.saveToken"))).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers no token to save without an environment", async () => {
		await setup();
		act(() => useApiExplorerStore.setState({ environments: [] }));
		respond({ body: '{"access_token":"test-token-123456"}' });
		act(() => screen.getByRole("button", { name: t("response.saveToken") }).click());
		expect(screen.queryByText(t("response.tokenSaved"))).not.toBeInTheDocument();
	});

	it("copies the answer, or says the clipboard refused", async () => {
		vi.useFakeTimers();
		try {
			const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
			await setup();
			// user-event installs its own clipboard; put this one in after it.
			Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
			respond({ body: "copied text" });

			await act(async () => screen.getByRole("button", { name: t("aria.copyResponse") }).click());
			expect(writeText).toHaveBeenCalledWith("copied text");
			expect(screen.getByRole("button", { name: t("export.copied") })).toBeInTheDocument();
			await act(async () => vi.advanceTimersByTime(2000));

			await act(async () => screen.getByRole("button", { name: t("aria.copyResponse") }).click());
			expect(screen.getByRole("button", { name: t("export.copyFailed") })).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resizes the answer by dragging its edge, within bounds", async () => {
		const { container } = await setup();
		respond({ body: "x" });
		const handle = container.querySelector(".cursor-row-resize") as HTMLElement;
		const panel = handle.nextElementSibling as HTMLElement;

		fireEvent.mouseMove(document, { clientY: 0 });
		expect(panel.style.height).toBe("240px");
		fireEvent.mouseDown(handle, { clientY: 500 });
		expect(document.body.style.cursor).toBe("row-resize");
		fireEvent.mouseMove(document, { clientY: 400 });
		expect(panel.style.height).toBe("340px");
		fireEvent.mouseMove(document, { clientY: -5000 });
		expect(panel.style.height).toBe("700px");
		fireEvent.mouseMove(document, { clientY: 5000 });
		expect(panel.style.height).toBe("80px");
		fireEvent.mouseUp(document);
		fireEvent.mouseUp(document);
		expect(document.body.style.cursor).toBe("");
	});
});

describe("RequestPanel docs", () => {
	it("documents the parameters, the body and the responses", async () => {
		const op: OpenApiOperation = {
			...OP,
			parameters: [...(OP.parameters ?? []), { name: "q", in: "query", schema: {} }],
			requestBody: { content: { "application/json": { schema: { type: "string", description: "A name" } } } },
		};
		const { user } = await setup({ operation: op });
		await user.click(tab(t("detail.docs")));

		expect(screen.getByText("Updates a user.")).toBeInTheDocument();
		expect(screen.getByText("User id")).toBeInTheDocument();
		expect(screen.getAllByText("required")).toHaveLength(1);
		expect(screen.getAllByText("any")).toHaveLength(3);
		expect(screen.getByText("string — A name")).toBeInTheDocument();
		expect(screen.getByText("Updated")).toBeInTheDocument();
		expect(screen.getByText("—")).toBeInTheDocument();
	});

	it("says when an operation documents nothing", async () => {
		const { user } = await setup({ method: "get", operation: {} });
		await user.click(tab(t("detail.docs")));
		expect(screen.getByText(t("detail.noSchema"))).toBeInTheDocument();
	});
});

describe("RequestPanel auth tab", () => {
	const typeSelect = () => screen.getByRole("button", { name: t("auth.type") });
	const pick = async (user: ReturnType<typeof userEvent.setup>, select: HTMLElement, option: string) => {
		await user.click(select);
		await user.click(screen.getByRole("button", { name: option }));
	};
	const auth = () => useApiExplorerStore.getState().requestAuth;

	it("shows the inherited token, or offers to set one on the environment", async () => {
		useApiExplorerStore.getState().updateEnvironment("local", { token: "test-env-abcdef" });
		const { user, rerender } = await setup();
		act(() => useApiExplorerStore.getState().updateEnvironment("local", { token: "test-env-abcdef" }));
		await user.click(tab(t("request.auth")));
		expect(screen.getByText(t("auth.inheritedFrom", { env: "Local" }))).toBeInTheDocument();
		expect(screen.getByText("Authorization: Bearer ••••abcdef")).toBeInTheDocument();

		act(() => useApiExplorerStore.getState().updateEnvironment("local", { token: "" }));
		await user.click(screen.getByRole("button", { name: t("auth.configureEnv") }));
		expect(onOpenEnvManager).toHaveBeenCalledTimes(1);
		expect(screen.getByText(t("auth.noEnvToken", { env: "Local" }))).toBeInTheDocument();

		act(() => useApiExplorerStore.setState({ environments: [] }));
		rerender(<RequestPanel method="put" path="/users/{id}" operation={OP} spec={SPEC} onOpenEnvManager={onOpenEnvManager} />);
		expect(screen.getByText(t("auth.noEnvToken", { env: t("environments.defaultName") }))).toBeInTheDocument();
	});

	it("edits a bearer token, Basic credentials and an API key", async () => {
		const { user } = await setup();
		await user.click(tab(t("request.auth")));

		await pick(user, typeSelect(), t("auth.types.none"));
		expect(screen.getByText(t("auth.noAuthDesc"))).toBeInTheDocument();

		await pick(user, typeSelect(), t("auth.types.bearer"));
		const token = screen.getByLabelText(t("auth.token"));
		expect(token).toHaveAttribute("type", "password");
		await user.type(token, "tok");
		await user.click(screen.getByRole("button", { name: t("aria.showSecret") }));
		expect(token).toHaveAttribute("type", "text");
		expect(auth().bearer).toBe("tok");

		await pick(user, typeSelect(), t("auth.types.basic"));
		await user.type(screen.getByLabelText(t("auth.username")), "ada");
		await user.type(screen.getByLabelText(t("auth.password")), "pw");
		await user.click(screen.getByRole("button", { name: t("aria.showSecret") }));
		expect(screen.getByLabelText(t("auth.password"))).toHaveAttribute("type", "text");

		await pick(user, typeSelect(), t("auth.types.apikey"));
		await user.clear(screen.getByLabelText(t("auth.keyName")));
		await user.type(screen.getByLabelText(t("auth.keyName")), "X-Key");
		await user.type(screen.getByLabelText(t("auth.keyValue")), "k");
		await pick(user, screen.getByRole("button", { name: t("auth.addTo") }), t("auth.locationQuery"));

		expect(auth()).toMatchObject({ type: "apikey", username: "ada", password: "pw", keyName: "X-Key", keyValue: "k", keyLocation: "query" });
		expect(tab(t("request.auth")).querySelector(".bg-warning")).not.toBeNull();
	});

	it("gets an OAuth 2.0 token through the main process", async () => {
		api.proxyHttpRequest.mockResolvedValue({ success: true, status: 200, body: '{"access_token":"test-access-0000"}' });
		const { user } = await setup();
		await user.click(tab(t("request.auth")));
		await pick(user, typeSelect(), t("auth.types.oauth2"));

		const getToken = screen.getByRole("button", { name: t("auth.oauth2.getToken") });
		await user.click(getToken);
		expect(screen.getByText(t("auth.oauth2.missingTokenUrl"))).toBeInTheDocument();
		expect(api.proxyHttpRequest).not.toHaveBeenCalled();

		await user.type(screen.getByLabelText(t("auth.oauth2.tokenUrl")), "https://auth.shop.com/token");
		await user.type(screen.getByLabelText(t("auth.oauth2.clientId")), "id");
		await user.type(screen.getByLabelText(t("auth.oauth2.clientSecret")), "s");
		await user.type(screen.getByLabelText(t("auth.oauth2.scope")), "read");
		await user.click(screen.getAllByRole("button", { name: t("aria.showSecret") })[0]);
		expect(screen.getByLabelText(t("auth.oauth2.clientSecret"))).toHaveAttribute("type", "text");
		await user.click(getToken);

		expect(sent()).toMatchObject({ url: "https://auth.shop.com/token", method: "POST" });
		expect(screen.getByPlaceholderText(t("auth.oauth2.tokenPlaceholder"))).toHaveValue("test-access-0000");
		expect(screen.queryByText(t("auth.oauth2.missingTokenUrl"))).not.toBeInTheDocument();

		await user.click(screen.getAllByRole("button", { name: t("aria.showSecret") })[1]);
		expect(screen.getByPlaceholderText(t("auth.oauth2.tokenPlaceholder"))).toHaveAttribute("type", "text");
		await user.clear(screen.getByPlaceholderText(t("auth.oauth2.tokenPlaceholder")));
		await user.type(screen.getByPlaceholderText(t("auth.oauth2.tokenPlaceholder")), "pasted");
		const prefix = screen.getByDisplayValue("Bearer");
		await user.clear(prefix);
		await user.type(prefix, "Token");
		expect(auth()).toMatchObject({ oauth2AccessToken: "pasted", oauth2HeaderPrefix: "Token" });
	});

	it("says why no token came back", async () => {
		const { user } = await setup();
		withAuth({ type: "oauth2", oauth2TokenUrl: "https://auth.shop.com/token" });
		await user.click(tab(t("request.auth")));
		const getToken = screen.getByRole("button", { name: t("auth.oauth2.getToken") });

		api.proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 401, body: '{"error":"invalid_client"}' });
		await user.click(getToken);
		expect(screen.getByText("invalid_client")).toBeInTheDocument();

		api.proxyHttpRequest.mockResolvedValueOnce({ success: true, status: 500, body: "" });
		await user.click(getToken);
		expect(screen.getByText(t("auth.oauth2.tokenError"))).toBeInTheDocument();

		api.proxyHttpRequest.mockRejectedValueOnce(new Error("offline"));
		await user.click(getToken);
		expect(screen.getByText("offline")).toBeInTheDocument();

		api.proxyHttpRequest.mockRejectedValueOnce("gone");
		await user.click(getToken);
		expect(screen.getByText("gone")).toBeInTheDocument();
	});

	it("shows the request on its way to the token endpoint", async () => {
		api.proxyHttpRequest.mockReturnValue(new Promise(() => undefined));
		const { user } = await setup();
		withAuth({ type: "oauth2", oauth2TokenUrl: "https://auth.shop.com/token" });
		await user.click(tab(t("request.auth")));
		await user.click(screen.getByRole("button", { name: t("auth.oauth2.getToken") }));
		expect(screen.getByRole("button", { name: t("auth.oauth2.getToken") })).toBeDisabled();
	});

	it("opens the sign-in page for the authorization code grant", async () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		try {
			const { user } = await setup();
			await user.click(tab(t("request.auth")));
			await pick(user, typeSelect(), t("auth.types.oauth2"));
			await pick(user, screen.getByRole("button", { name: t("auth.oauth2.grantType") }), t("auth.oauth2.grants.authorization_code"));

			const browser = screen.getByRole("button", { name: t("auth.oauth2.openBrowser") });
			await user.click(browser);
			expect(open).not.toHaveBeenCalled();
			await user.type(screen.getByLabelText(t("auth.oauth2.authUrl")), "https://auth.shop.com/authorize");
			await user.click(browser);
			expect(open).toHaveBeenCalledWith("https://auth.shop.com/authorize", "_blank");
			expect(api.proxyHttpRequest).not.toHaveBeenCalled();
		} finally {
			open.mockRestore();
		}
	});

	it("asks for the person's credentials for the password grant", async () => {
		const { user } = await setup();
		await user.click(tab(t("request.auth")));
		await pick(user, typeSelect(), t("auth.types.oauth2"));
		await pick(user, screen.getByRole("button", { name: t("auth.oauth2.grantType") }), t("auth.oauth2.grants.password"));

		await user.type(screen.getByLabelText(t("auth.username")), "ada");
		await user.type(screen.getByLabelText(t("auth.password")), "pw");
		expect(auth()).toMatchObject({ oauth2GrantType: "password", username: "ada", password: "pw" });
	});

	it("closes a picker when the person clicks elsewhere", async () => {
		const { user } = await setup();
		await user.click(tab(t("request.auth")));
		await user.click(typeSelect());
		expect(typeSelect()).toHaveAttribute("aria-expanded", "true");
		await user.click(typeSelect());
		await user.click(typeSelect());
		await user.click(within(document.body).getByText(t("auth.type")));
		await user.click(document.body);
		expect(typeSelect()).toHaveAttribute("aria-expanded", "false");
	});
});

describe("RequestPanel secrets", () => {
	it("reads the request's secrets, then saves what changes", async () => {
		api.loadApiExplorerSecrets.mockResolvedValue({ success: true, data: { bearer: "test-stored-0000" } });
		await setup();
		expect(api.loadApiExplorerSecrets).toHaveBeenCalledWith("request:p1:PUT:/users/{id}");
		await waitFor(() => expect(useApiExplorerStore.getState().requestAuth.bearer).toBe("test-stored-0000"));

		api.saveApiExplorerSecrets.mockClear();
		act(() => useApiExplorerStore.getState().setRequestAuth({ password: "pw" }));
		expect(api.saveApiExplorerSecrets).toHaveBeenCalledWith("request:p1:PUT:/users/{id}", {
			bearer: "test-stored-0000",
			password: "pw",
			keyValue: "",
			oauth2ClientSecret: "",
			oauth2AccessToken: "",
		});
	});

	it("keeps what it has when the store cannot be read, and saves nothing before", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.loadApiExplorerSecrets.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
		await setup();
		act(() => useApiExplorerStore.getState().setRequestAuth({ bearer: "typed" }));
		expect(api.saveApiExplorerSecrets).not.toHaveBeenCalled();

		await act(async () => answer({ success: false, error: "locked" }));
		expect(useApiExplorerStore.getState().requestAuth.bearer).toBe("typed");
	});

	it("ignores the answer for an endpoint it already left", async () => {
		let answer: (value: unknown) => void = () => undefined;
		api.loadApiExplorerSecrets.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
		const { rerender } = await setup();
		rerender(<RequestPanel method="get" path="/other" operation={{}} spec={SPEC} onOpenEnvManager={onOpenEnvManager} />);
		await act(async () => answer({ success: true, data: { bearer: "for-the-old-one" } }));
		expect(useApiExplorerStore.getState().requestAuth.bearer).toBe("");
	});

	it("reads no secrets outside a project", async () => {
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: "p2" });
		await setup();
		expect(api.loadApiExplorerSecrets).toHaveBeenCalledWith("request:p2:PUT:/users/{id}");
		api.loadApiExplorerSecrets.mockClear();
		useProjectStore.setState({ activeProjectId: null, selectedProjectId: null });
		await setup();
		expect(api.loadApiExplorerSecrets).not.toHaveBeenCalled();
	});
});

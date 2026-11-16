/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_REQUEST_AUTH,
	makeEndpointKey,
	useApiExplorerStore,
} from "./api-explorer-store";

describe("api explorer project request drafts", () => {
	beforeEach(() => {
		localStorage.clear();
		useApiExplorerStore.persist.clearStorage();
		useApiExplorerStore.setState({
			activeProjectId: null,
			selectedEndpointKey: null,
			requestDrafts: {},
			selectedEndpointByProject: {},
			requestPathParams: {},
			requestQueryParams: {},
			requestHeaders: {},
			requestBody: "",
			requestAuth: { ...DEFAULT_REQUEST_AUTH },
		});
	});

	it("restores request values independently for each project and endpoint", () => {
		const users = makeEndpointKey("GET", "/users/{id}");
		const builds = makeEndpointKey("POST", "/builds");
		const store = useApiExplorerStore.getState();

		store.setActiveProjectContext("project-test");
		store.setSelectedEndpointKey(users);
		store.setRequestPathParams({ id: "42" });
		store.setRequestQueryParams({ expand: "teams" });
		store.setRequestBody('{"name":"Ada"}');

		store.setSelectedEndpointKey(builds);
		expect(useApiExplorerStore.getState().requestPathParams).toEqual({});

		useApiExplorerStore.getState().setActiveProjectContext("project-other");
		useApiExplorerStore.getState().setSelectedEndpointKey(users);
		expect(useApiExplorerStore.getState().requestPathParams).toEqual({});

		useApiExplorerStore.getState().setActiveProjectContext("project-test");
		useApiExplorerStore.getState().setSelectedEndpointKey(users);
		expect(useApiExplorerStore.getState().requestPathParams).toEqual({ id: "42" });
		expect(useApiExplorerStore.getState().requestQueryParams).toEqual({
			expand: "teams",
		});
		expect(useApiExplorerStore.getState().requestBody).toBe('{"name":"Ada"}');
	});

	it("never persists request secrets or environment tokens in localStorage", () => {
		const endpoint = makeEndpointKey("GET", "/private");
		const store = useApiExplorerStore.getState();
		store.setActiveProjectContext("project-test");
		store.setSelectedEndpointKey(endpoint);
		store.setRequestAuth({
			type: "oauth2",
			bearer: "bearer-secret",
			password: "password-secret",
			keyValue: "api-key-secret",
			oauth2ClientSecret: "client-secret",
			oauth2AccessToken: "access-secret",
		});
		store.updateEnvironment("local", { token: "environment-secret" });

		const serialized = localStorage.getItem("api-explorer-store") ?? "";
		expect(serialized).not.toContain("bearer-secret");
		expect(serialized).not.toContain("password-secret");
		expect(serialized).not.toContain("api-key-secret");
		expect(serialized).not.toContain("client-secret");
		expect(serialized).not.toContain("access-secret");
		expect(serialized).not.toContain("environment-secret");
	});
});

describe("api explorer environments, tags and responses", () => {
	const initial = useApiExplorerStore.getState();
	beforeEach(() => {
		localStorage.clear();
		useApiExplorerStore.setState(initial, true);
		useApiExplorerStore.setState({
			environments: [
				{ id: "local", name: "Local", baseUrl: "http://localhost:3000", headers: {} },
			],
			activeEnvironmentId: "local",
		});
	});

	it("gives environments added together different ids", () => {
		const store = useApiExplorerStore.getState();
		store.addEnvironment({ name: "A", baseUrl: "http://a", headers: {} });
		store.addEnvironment({ name: "B", baseUrl: "http://b", headers: {} });
		const ids = useApiExplorerStore.getState().environments.map((e) => e.id);
		expect(new Set(ids).size).toBe(3);
	});

	it("moves to an environment that remains when the active one is removed", () => {
		const store = useApiExplorerStore.getState();
		store.addEnvironment({ name: "Prod", baseUrl: "http://p", headers: {} });
		const prod = useApiExplorerStore.getState().environments[1].id;

		store.removeEnvironment("local");
		expect(useApiExplorerStore.getState().activeEnvironmentId).toBe(prod);

		store.setActiveEnvironment(prod);
		store.addEnvironment({ name: "QA", baseUrl: "http://q", headers: {} });
		const qa = useApiExplorerStore.getState().environments[1].id;
		store.removeEnvironment(qa);
		expect(useApiExplorerStore.getState().activeEnvironmentId).toBe(prod);

		store.removeEnvironment(prod);
		expect(useApiExplorerStore.getState()).toMatchObject({
			environments: [],
			activeEnvironmentId: "local",
		});
	});

	it("folds a tag and unfolds it", () => {
		const store = useApiExplorerStore.getState();
		store.toggleTag("users");
		store.toggleTag("orders");
		expect(useApiExplorerStore.getState().collapsedTags).toEqual(["users", "orders"]);
		store.toggleTag("users");
		expect(useApiExplorerStore.getState().collapsedTags).toEqual(["orders"]);
	});

	it("keeps no draft outside a project, but still shows the headers typed", () => {
		useApiExplorerStore.setState({ activeProjectId: null, selectedEndpointKey: makeEndpointKey("GET", "/a") });
		useApiExplorerStore.getState().setRequestHeaders({ "X-A": "1" });
		expect(useApiExplorerStore.getState()).toMatchObject({
			requestHeaders: { "X-A": "1" },
			requestDrafts: {},
		});
	});

	it("leaves a project with nothing selected and no contract address", () => {
		useApiExplorerStore.setState({ specUrlsByProject: { p1: "http://a/openapi.json" } });
		const store = useApiExplorerStore.getState();
		store.setActiveProjectContext("p1");
		expect(useApiExplorerStore.getState().specUrl).toBe("http://a/openapi.json");
		store.setActiveProjectContext(null);
		expect(useApiExplorerStore.getState()).toMatchObject({ specUrl: "", selectedEndpointKey: null });
	});

	it("records a response, which ends the sending, and clears it", () => {
		const store = useApiExplorerStore.getState();
		store.setIsSendingRequest(true);
		store.setResponse({ status: 201, statusText: "Created", headers: { a: "1" }, body: "{}", time: 12 });
		expect(useApiExplorerStore.getState()).toMatchObject({
			responseStatus: 201,
			responseStatusText: "Created",
			responseHeaders: { a: "1" },
			responseBody: "{}",
			responseTime: 12,
			isSendingRequest: false,
		});

		store.clearResponse();
		expect(useApiExplorerStore.getState()).toMatchObject({
			responseStatus: null,
			responseStatusText: "",
			responseHeaders: {},
			responseBody: "",
			responseTime: null,
		});
	});
});

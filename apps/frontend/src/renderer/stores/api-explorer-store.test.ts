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

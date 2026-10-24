import { describe, expect, it } from "vitest";
import { envWithoutCredentials, isCredentialName } from "../child-env";

describe("envWithoutCredentials", () => {
	const base = {
		PATH: "/usr/bin",
		HOME: "/home/me",
		ANTHROPIC_API_KEY: "sk-test-0000",
		CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-0000",
		GITHUB_TOKEN: "test-gh-0000",
		AWS_SECRET_ACCESS_KEY: "test-aws-0000",
		AWS_SESSION_TOKEN: "test-aws-0000",
		DB_PASSWORD: "test-0000",
		SLACK_WEBHOOK_URL: "https://hooks.example/0000",
		NODE_ENV: "development",
		TOKENIZERS_PARALLELISM: "false",
	};

	it("keeps what a program needs to run and drops every credential", () => {
		expect(envWithoutCredentials(base)).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/me",
			NODE_ENV: "development",
			TOKENIZERS_PARALLELISM: "false",
		});
	});

	it("adds the caller's own variables", () => {
		expect(envWithoutCredentials(base, { PORT: "3000" }).PORT).toBe("3000");
	});

	it("recognises a credential by its name, not by its value", () => {
		expect(isCredentialName("MY_SERVICE_API_KEY")).toBe(true);
		expect(isCredentialName("azure_devops_pat")).toBe(true);
		expect(isCredentialName("PATH")).toBe(false);
		expect(isCredentialName("PATHEXT")).toBe(false);
		expect(isCredentialName("TOKENIZERS_PARALLELISM")).toBe(false);
	});
});

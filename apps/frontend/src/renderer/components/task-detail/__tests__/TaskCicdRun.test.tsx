/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { CicdAutoRun } from "../../../../shared/types";
import { TaskCicdRun } from "../TaskCicdRun";

const openExternal = vi.fn();

beforeEach(() => {
	openExternal.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { openExternal };
});

const base: CicdAutoRun = {
	id: "1",
	provider: "gitlab",
	event: "pr",
	status: "triggered",
	triggeredAt: new Date().toISOString(),
};

describe("TaskCicdRun", () => {
	it("says which pipeline started after the PR and opens it", () => {
		render(<TaskCicdRun run={{ ...base, webUrl: "https://gitlab.com/acme/shop/-/pipelines/9" }} />);
		expect(screen.getByTestId("task-cicd-run")).toHaveTextContent(/GitLab CI/);
		fireEvent.click(screen.getByRole("button"));
		expect(openExternal).toHaveBeenCalledWith("https://gitlab.com/acme/shop/-/pipelines/9");
	});

	it("shows why a pipeline after the merge could not start, with no link", () => {
		render(
			<TaskCicdRun
				run={{ ...base, provider: "github", event: "merge", status: "failed", error: "CICD_GITHUB_TOKEN not configured" }}
			/>,
		);
		expect(screen.getByTestId("task-cicd-run")).toHaveTextContent(/GitHub Actions/);
		expect(screen.getByText("CICD_GITHUB_TOKEN not configured")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});
});

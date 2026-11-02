/**
 * The changelog view of a server project: the last changelog a member built
 * on the server is shown, and opens; saving keeps it on the server for the
 * team, and the steps that act on this computer's project (a file, a GitHub
 * release, archiving tasks) are not offered. A local project keeps its own.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "../../../stores/project-store";
import { TooltipProvider } from "../../ui/tooltip";
import { PreviewPanel } from "../PreviewPanel";
import { SharedChangelogNote } from "../SharedChangelogNote";
import { Step3SuccessScreen } from "../Step3SuccessScreen";

const MIRROR = "/data/server-boards/abc/p-1";

const serverProject = {
	id: "p-1",
	name: "Shop",
	path: MIRROR,
	remote: { repoUrl: "https://github.com/acme/shop.git", defaultBranch: "main", role: "viewer" },
} as unknown as Project;

const localProject = { id: "local-1", name: "Mine", path: "/home/me/mine" } as unknown as Project;

const getSharedAnalysisReport = vi.fn();

beforeEach(() => {
	getSharedAnalysisReport.mockReset();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		...(globalThis as unknown as { electronAPI?: object }).electronAPI,
		getSharedAnalysisReport,
	};
	useProjectStore.setState({ projects: [serverProject, localProject] });
});

afterEach(() => {
	useProjectStore.setState({ projects: [], selectedProjectId: null });
});

describe("the changelog view of a server project", () => {
	it("shows the last shared changelog, read by the mirror's folder, and opens it", async () => {
		useProjectStore.setState({ selectedProjectId: "p-1" });
		getSharedAnalysisReport.mockResolvedValueOnce({
			report: { changelog: "## [1.2.0]\n- Cart", version: "1.2.0" },
			finishedAt: "2026-11-02T10:00:00+00:00",
			runBy: "u-ada",
		});
		const onOpen = vi.fn();
		render(<SharedChangelogNote isGenerating={false} onOpen={onOpen} />);
		expect(await screen.findByText(/version 1\.2\.0/)).toBeInTheDocument();
		expect(getSharedAnalysisReport).toHaveBeenCalledWith("changelog", MIRROR);
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		expect(onOpen).toHaveBeenCalledWith("## [1.2.0]\n- Cart", "1.2.0");
	});

	it("shows nothing when no member built one yet", async () => {
		useProjectStore.setState({ selectedProjectId: "p-1" });
		getSharedAnalysisReport.mockResolvedValueOnce(null);
		const { container } = render(<SharedChangelogNote isGenerating={false} onOpen={vi.fn()} />);
		await waitFor(() => expect(getSharedAnalysisReport).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
	});

	it("a local project asks for no shared changelog", () => {
		useProjectStore.setState({ selectedProjectId: "local-1" });
		const { container } = render(<SharedChangelogNote isGenerating={false} onOpen={vi.fn()} />);
		expect(container).toBeEmptyDOMElement();
		expect(getSharedAnalysisReport).not.toHaveBeenCalled();
	});

	it("saves for the team, not to a file", () => {
		const props = {
			generatedChangelog: "## [1.2.0]",
			saveSuccess: false,
			copySuccess: false,
			canSave: true,
			isDragOver: false,
			imageError: null,
			textareaRef: { current: null },
			onSave: vi.fn(),
			onCopy: vi.fn(),
			onChangelogEdit: vi.fn(),
			onPaste: vi.fn(),
			onDragOver: vi.fn(),
			onDragLeave: vi.fn(),
			onDrop: vi.fn(),
		};
		const { rerender } = render(
			<TooltipProvider>
				<PreviewPanel {...props} serverProject />
			</TooltipProvider>,
		);
		expect(screen.getByRole("button", { name: /Save for the team/ })).toBeInTheDocument();
		rerender(
			<TooltipProvider>
				<PreviewPanel {...props} />
			</TooltipProvider>,
		);
		expect(screen.getByRole("button", { name: /Save to CHANGELOG\.md/ })).toBeInTheDocument();
	});

	it("once saved, offers no release or archive of this computer's project", () => {
		render(
			<Step3SuccessScreen
				projectId="p-1"
				version="1.2.0"
				selectedTaskIds={[]}
				doneTasks={[]}
				generatedChangelog="## [1.2.0]"
				serverProject
				onDone={vi.fn()}
			/>,
		);
		expect(screen.getByText("Changelog shared")).toBeInTheDocument();
		expect(screen.getByText(/Version v1\.2\.0 is the project's shared changelog/)).toBeInTheDocument();
		expect(screen.queryByText("Create GitHub Release")).not.toBeInTheDocument();
		expect(screen.queryByText("Archive Completed Tasks")).not.toBeInTheDocument();
	});
});

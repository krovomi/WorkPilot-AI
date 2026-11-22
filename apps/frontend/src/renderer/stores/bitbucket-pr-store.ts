/**
 * The Bitbucket pull requests view: the pull requests of the project on
 * screen in one state, a pull request's diff and comments, the latest
 * pipelines and a pipeline's steps. Like the issues view, an answer that
 * arrives after a project switch is dropped, and loading another project
 * starts from an empty view.
 */

import { create } from "zustand";
import type {
	BitbucketComment,
	BitbucketPipeline,
	BitbucketPipelineStep,
	BitbucketPullRequest,
	BitbucketPullRequestDiff,
	BitbucketPullRequestState,
	IPCResult,
} from "../../shared/types";
import { failure, isShownProject } from "./bitbucket-issues-store";

interface BitbucketPrState {
	projectId: string | null;
	state: BitbucketPullRequestState;
	pullRequests: BitbucketPullRequest[];
	isLoading: boolean;
	error: string | null;
	selectedId: number | null;
	diffs: Record<number, BitbucketPullRequestDiff>;
	comments: Record<number, BitbucketComment[]>;
	detailError: string | null;
	pipelines: BitbucketPipeline[];
	pipelinesLoading: boolean;
	pipelinesError: string | null;
	steps: Record<string, BitbucketPipelineStep[]>;
	selectPullRequest: (id: number | null) => void;
}

const EMPTY = {
	pullRequests: [],
	isLoading: false,
	error: null,
	selectedId: null,
	diffs: {},
	comments: {},
	detailError: null,
	pipelines: [],
	pipelinesLoading: false,
	pipelinesError: null,
	steps: {},
};

export const useBitbucketPrStore = create<BitbucketPrState>((set) => ({
	projectId: null,
	state: "OPEN",
	...EMPTY,
	selectPullRequest: (selectedId) => set({ selectedId, detailError: null }),
}));

/** A call that threw, read as one that failed without a message. */
const refused = (): IPCResult<never> => ({ success: false });
const store = () => useBitbucketPrStore.getState();
const current = (projectId: string) => isShownProject(projectId) && store().projectId === projectId;

function forProject(projectId: string): void {
	if (store().projectId !== projectId) useBitbucketPrStore.setState({ projectId, ...EMPTY });
}

export async function loadBitbucketPullRequests(
	projectId: string,
	state: BitbucketPullRequestState = store().state,
): Promise<void> {
	forProject(projectId);
	useBitbucketPrStore.setState({ isLoading: true, error: null, state });
	const result = await window.electronAPI.bitbucket.getPullRequests(projectId, state).catch(() => undefined);
	if (!current(projectId) || store().state !== state) return;
	if (result?.success && result.data) {
		useBitbucketPrStore.setState({ pullRequests: result.data, isLoading: false });
	} else {
		useBitbucketPrStore.setState({ error: failure(result, "bitbucket:errors.loadPullRequests"), isLoading: false });
	}
}

/** The diff and the comments of a pull request, each once. */
export async function loadBitbucketPullRequestDetail(projectId: string, id: number): Promise<void> {
	const api = window.electronAPI.bitbucket;
	const [diff, comments] = await Promise.all([
		store().diffs[id] ? undefined : api.getPullRequestDiff(projectId, id).catch(refused),
		store().comments[id] ? undefined : api.getPullRequestComments(projectId, id).catch(refused),
	]);
	if (!current(projectId)) return;
	const loaded = diff?.success ? diff.data : undefined;
	const thread = comments?.success ? comments.data : undefined;
	const failed = [diff, comments].find((r) => r !== undefined && !r.success);
	useBitbucketPrStore.setState((s) => ({
		diffs: loaded ? { ...s.diffs, [id]: loaded } : s.diffs,
		comments: thread ? { ...s.comments, [id]: thread } : s.comments,
		detailError: failed ? failure(failed, "bitbucket:errors.loadDetail") : null,
	}));
}

export async function loadBitbucketPipelines(projectId: string): Promise<void> {
	forProject(projectId);
	useBitbucketPrStore.setState({ pipelinesLoading: true, pipelinesError: null });
	const result = await window.electronAPI.bitbucket.getPipelines(projectId).catch(() => undefined);
	if (!current(projectId)) return;
	if (result?.success && result.data) {
		useBitbucketPrStore.setState({ pipelines: result.data, pipelinesLoading: false });
	} else {
		useBitbucketPrStore.setState({
			pipelinesError: failure(result, "bitbucket:errors.loadPipelines"),
			pipelinesLoading: false,
		});
	}
}

export async function loadBitbucketPipelineSteps(projectId: string, uuid: string): Promise<void> {
	const result = await window.electronAPI.bitbucket.getPipelineSteps(projectId, uuid).catch(() => undefined);
	if (!current(projectId) || !result?.success || !result.data) return;
	const steps = result.data;
	useBitbucketPrStore.setState((s) => ({ steps: { ...s.steps, [uuid]: steps } }));
}

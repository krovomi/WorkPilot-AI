/**
 * The Bitbucket view the sidebar picked, for the project on screen. App.tsx
 * mounts this one component (it is at its size cap) and loads it lazily.
 */

import { BitbucketIssues } from "./BitbucketIssues";
import { BitbucketPullRequests } from "./BitbucketPullRequests";

interface BitbucketViewsProps {
	readonly view: string;
	readonly projectId: string;
	readonly onOpenSettings: () => void;
}

export function BitbucketViews({ view, projectId, onOpenSettings }: BitbucketViewsProps) {
	if (view === "bitbucket-issues") return <BitbucketIssues projectId={projectId} onOpenSettings={onOpenSettings} />;
	if (view === "bitbucket-pull-requests") {
		return <BitbucketPullRequests projectId={projectId} onOpenSettings={onOpenSettings} />;
	}
	return null;
}

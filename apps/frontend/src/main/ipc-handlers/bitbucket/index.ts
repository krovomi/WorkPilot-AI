/**
 * Registers every Bitbucket Cloud IPC handler: the connection check, the
 * issue tracker and its import, pull requests and pipelines.
 * Design: docs/architecture/bitbucket.md.
 */

import { registerBitbucketIssueHandlers } from "./issue-handlers";
import { registerBitbucketPullRequestHandlers } from "./pull-request-handlers";

export function registerBitbucketHandlers(): void {
	registerBitbucketIssueHandlers();
	registerBitbucketPullRequestHandlers();
}

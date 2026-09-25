import { IPC_CHANNELS } from "../../../shared/constants";
import type {
	ImageAttachment,
	IPCResult,
	JiraSyncStatus,
	JiraWorkItem,
} from "../../../shared/types";
import { invokeIpc } from "./ipc-utils";

/**
 * Jira Integration API operations
 */
export interface JiraAPI {
	getJiraIssues: (
		projectId: string,
		maxItems?: number,
	) => Promise<IPCResult<JiraWorkItem[]>>;
	getJiraIssue: (
		projectId: string,
		issueKey: string,
	) => Promise<IPCResult<JiraWorkItem>>;
	checkJiraConnection: (
		projectId: string,
	) => Promise<IPCResult<JiraSyncStatus>>;
	/** The issue's image attachments, as task attachments (base64). */
	getJiraAttachments: (
		projectId: string,
		issueKey: string,
	) => Promise<IPCResult<ImageAttachment[]>>;
	testJiraConnection: (config: {
		instanceUrl: string;
		email: string;
		apiToken: string;
	}) => Promise<IPCResult<JiraSyncStatus>>;
}

/**
 * Creates the Jira Integration API implementation
 */
export const createJiraAPI = (): JiraAPI => ({
	getJiraIssues: (
		projectId: string,
		maxItems?: number,
	): Promise<IPCResult<JiraWorkItem[]>> =>
		invokeIpc(IPC_CHANNELS.JIRA_GET_ISSUES, projectId, maxItems),

	getJiraIssue: (
		projectId: string,
		issueKey: string,
	): Promise<IPCResult<JiraWorkItem>> =>
		invokeIpc(IPC_CHANNELS.JIRA_GET_ISSUE, projectId, issueKey),

	checkJiraConnection: (
		projectId: string,
	): Promise<IPCResult<JiraSyncStatus>> =>
		invokeIpc(IPC_CHANNELS.JIRA_CHECK_CONNECTION, projectId),

	getJiraAttachments: (
		projectId: string,
		issueKey: string,
	): Promise<IPCResult<ImageAttachment[]>> =>
		invokeIpc(IPC_CHANNELS.JIRA_GET_ATTACHMENTS, projectId, issueKey),

	testJiraConnection: (config: {
		instanceUrl: string;
		email: string;
		apiToken: string;
	}): Promise<IPCResult<JiraSyncStatus>> =>
		invokeIpc(IPC_CHANNELS.JIRA_TEST_CONNECTION, config),
});

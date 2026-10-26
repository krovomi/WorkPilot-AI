/**
 * MCP Apps in the task panel.
 *
 * A tool of an installed MCP server can name a view (`_meta.ui.resourceUri`).
 * When the agent calls it during a build, the backend keeps the view in the
 * task's spec directory (`mcp-apps/<viewId>.json`) and tells the card
 * (`MCP_APP_VIEW`). The renderer only ever names a view by its id; the main
 * process reads the file and serves the view on its own scheme, with its own
 * CSP. See docs/architecture/mcp-2026.md.
 */

/** One kept view, as the list shows it (no HTML). */
export interface McpAppViewSummary {
	viewId: string;
	server: string;
	tool: string;
	/** Seconds since the epoch, as the backend wrote it. */
	createdAt: number;
}

/** What the frame needs to show one view. */
export interface McpAppViewOpened extends McpAppViewSummary {
	/** `workpilot-mcp-app://<token>/`: valid until the frame closes it. */
	url: string;
	token: string;
	/** The call's arguments and result, sent to the view once it is ready. */
	toolInput: Record<string, unknown>;
	toolResult: Record<string, unknown>;
	/** The resource's `prefersBorder`. */
	prefersBorder: boolean;
}

/**
 * An organization's security reviews of catalogue MCP servers (#369, lots 5
 * and 6). The server keeps them with the organization, read from any of its
 * projects and by no other organization
 * (`apps/backend/shared_features/mcp_reviews.py`); the main reads and writes
 * them for the marketplace (`main/mcp-reviews.ts`).
 */

/** The verdicts a review may give, from the safest. */
export const MCP_REVIEW_VERDICTS = ["safe", "caution", "unsafe"] as const;
export type McpReviewVerdict = (typeof MCP_REVIEW_VERDICTS)[number];

/** As `MAX_COMMENT` on the server. */
export const MCP_REVIEW_MAX_COMMENT = 1000;

export interface McpServerReview {
	id: string;
	serverId: string;
	verdict: McpReviewVerdict;
	/** Plain text, shown as text. */
	comment: string;
	author: string;
	updatedAt: string | null;
	/** The caller wrote it. */
	mine: boolean;
	/** The caller may delete it: its author, or an organization administrator. */
	canDelete: boolean;
}

export interface McpReviewList {
	reviews: McpServerReview[];
	/** The server grants the caller `marketplace.write` (maintainers, administrators). */
	canWrite: boolean;
}

export interface McpReviewRequest {
	projectId: string;
	serverId: string;
	verdict: McpReviewVerdict;
	comment: string;
}

export interface McpReviewListRequest {
	projectId: string;
	serverId: string;
}

export interface McpReviewDeleteRequest {
	projectId: string;
	reviewId: string;
}

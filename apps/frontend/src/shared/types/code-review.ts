export type ReviewScope = "all" | "staged" | "working";
export interface ReviewFileEntry {
	path: string;
	status: string;
}
export interface ReviewFileData {
	path: string;
	content: string;
	patch: string;
	unavailable?: "binary" | "large" | "deleted" | "missingRevision";
}

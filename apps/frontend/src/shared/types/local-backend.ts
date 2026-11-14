/** A request to the local backend, made by main for the renderer. */
export interface LocalBackendRequest {
	method: "GET" | "POST";
	/** Backend-relative: a path and its query, `/api/rtk/status?project_dir=…`. */
	url: string;
	/** A JSON body, for a POST. */
	body?: string;
	/** The answer is a file (an image, a video, a zip): sent as bytes. */
	binary?: boolean;
}

/** The backend's raw answer, or that nothing answered. */
export type LocalBackendResponse =
	| { status: number; contentType: string; text: string }
	| { status: number; contentType: string; bytes: Uint8Array }
	| { unreachable: true };

/**
 * A server card's captures for its pull request (`shared_board/captures.py`):
 * what the pull request shows, kinds of data replaced by fakes, never a value
 * nor a path. A screen is named by its place in `items`.
 */

export type CaptureStatus = "pseudonymized" | "clean" | "unchecked" | "withheld" | "failed" | string;

export interface CaptureSide {
	/** A published copy (fakes in place of personal data) can be shown. */
	available: boolean;
	status: CaptureStatus;
	/** How many values were replaced by fakes. */
	replaced: number;
	/** The kinds found (`email`, `phone`, `iban`, `card`, `name`…), never a value. */
	kinds: string[];
	/** The checks that ran: `page`, `ocr:<engine>`. */
	passes: string[];
}

export interface CaptureItem {
	key: string;
	label: string;
	platform: string;
	variant: string;
	route: string;
	locale: string;
	before: CaptureSide | null;
	after: CaptureSide | null;
	publishable: boolean;
}

export type PublishMode = "auto" | "review" | "never" | "";

export interface CaptureSync {
	status: string;
	reason: string;
	hosted: number;
	syncedAt: string;
	prUrl: string;
}

export interface CardCaptures {
	needed: boolean;
	reason: string;
	items: CaptureItem[];
	publishable: number;
	withheld: number;
	publish: PublishMode;
	/** False when the team published the captures as taken, without fakes. */
	protect?: boolean;
	/** Review mode: every copy the pull request would show was published by a person. */
	approved: boolean;
	sync: CaptureSync | null;
}

export type CaptureSideName = "before" | "after";

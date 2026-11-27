/**
 * The phone's side of page activity: count, per day, how many times the
 * person opened each screen of `MOBILE_PAGES`, and send the counts in one
 * batch (`POST /users/me/page-activity`), only while their organization
 * turned page activity on (`GET`, asked once, then at each send). One
 * instance belongs to one person in one organization: a sign-out or another
 * organization starts a new one, and what was not sent is dropped.
 */

import type { Api } from "../api/endpoints";
import type { MobilePage } from "./pages";

/** As the server bounds a batch and a count (`services/page_activity.py`). */
const MAX_VISITS = 200;
const MAX_COUNT = 10_000;

type Server = Pick<Api, "pageActivity" | "sendPageActivity">;

export class PageActivity {
	private enabled: boolean | null = null;
	private asking: Promise<void> | null = null;
	private sending = false;
	private readonly counts = new Map<string, number>();

	constructor(
		private readonly server: Server,
		/** Whose counts these are: the person and the organization they act in. */
		readonly owner: string,
	) {}

	private async askState(): Promise<void> {
		try {
			this.enabled = (await this.server.pageActivity()).enabled === true;
		} catch {
			// A server that cannot answer counts as off until the next send.
			this.enabled = false;
		}
		if (!this.enabled) this.counts.clear();
	}

	/** The person opened `page`; whether it was counted. */
	async note(page: MobilePage, now = new Date()): Promise<boolean> {
		if (this.enabled === null) {
			this.asking ??= this.askState();
			await this.asking;
		}
		if (!this.enabled) return false;
		const key = `${now.toISOString().slice(0, 10)}|${page}`;
		if (!this.counts.has(key) && this.counts.size >= MAX_VISITS) return false;
		this.counts.set(key, Math.min((this.counts.get(key) ?? 0) + 1, MAX_COUNT));
		return true;
	}

	/**
	 * Send what was not sent; with nothing to send, ask again whether page
	 * activity is on. What could not be sent is kept for the next time.
	 */
	async flush(): Promise<number> {
		if (this.sending) return 0;
		if (this.counts.size === 0) {
			await this.askState();
			return 0;
		}
		this.sending = true;
		const sent = new Map(this.counts);
		const visits = [...sent].map(([key, count]) => {
			const [day, page] = key.split("|") as [string, string];
			return { day, page, count };
		});
		try {
			const answer = await this.server.sendPageActivity(visits);
			for (const [key, count] of sent) {
				const left = (this.counts.get(key) ?? 0) - count;
				if (left > 0) this.counts.set(key, left);
				else this.counts.delete(key);
			}
			this.enabled = answer.enabled === true;
			if (!this.enabled) this.counts.clear();
			return answer.recorded;
		} catch {
			return 0;
		} finally {
			this.sending = false;
		}
	}
}

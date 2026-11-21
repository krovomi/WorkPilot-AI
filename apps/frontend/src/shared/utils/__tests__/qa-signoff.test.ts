import { describe, expect, it } from "vitest";
import { qaSignoffOf } from "../qa-signoff";

describe("qaSignoffOf", () => {
	it("reads an approval or a rejection with the session that wrote it", () => {
		expect(qaSignoffOf({ qa_signoff: { status: "approved", qa_session: 1 } })).toEqual({
			status: "approved",
			session: 1,
		});
		expect(qaSignoffOf({ qa_signoff: { status: "rejected", qa_session: 3 } })).toEqual({
			status: "rejected",
			session: 3,
		});
	});

	it("reads nothing from a plan without a sign-off", () => {
		expect(qaSignoffOf(null)).toBeUndefined();
		expect(qaSignoffOf(undefined)).toBeUndefined();
		expect(qaSignoffOf({})).toBeUndefined();
		expect(
			qaSignoffOf({ qa_signoff: "approved" as unknown as { status: unknown } }),
		).toBeUndefined();
	});

	it("reads nothing from a sign-off an agent wrote wrong", () => {
		for (const qa_signoff of [
			{ status: "fixes_applied", qa_session: 1 },
			{ status: "approved" },
			{ status: "approved", qa_session: "1" },
			{ status: "approved", qa_session: 0 },
			{ status: "approved", qa_session: 1.5 },
		]) {
			expect(qaSignoffOf({ qa_signoff })).toBeUndefined();
		}
	});
});

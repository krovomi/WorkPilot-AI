import type { ImplementationPlan, TaskQaSignoff } from "../types/task";

/**
 * The QA reviewer's sign-off as the plan holds it, or nothing.
 *
 * The plan is a file an agent writes, so nothing in it is taken as typed: a
 * status other than approved or rejected, or a session that is not a whole
 * number from 1, reads as no sign-off rather than a wrong one.
 */
export function qaSignoffOf(
	plan: Pick<ImplementationPlan, "qa_signoff"> | null | undefined,
): TaskQaSignoff | undefined {
	const signoff = plan?.qa_signoff;
	if (!signoff || typeof signoff !== "object") return undefined;
	const { status, qa_session: session } = signoff;
	if (status !== "approved" && status !== "rejected") return undefined;
	if (typeof session !== "number" || !Number.isInteger(session) || session < 1)
		return undefined;
	return { status, session };
}

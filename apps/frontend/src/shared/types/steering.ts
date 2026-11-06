/**
 * A message the person sends to a running task (`apps/backend/foundation/steering.py`).
 */

export interface SteeringMessage {
	id: string;
	text: string;
	createdAt: string;
	source: string;
	/** Only this subtask's session receives it; `null`: the next session. */
	targetSubtaskId: string | null;
	/** Set by WorkPilot once a session received it: the acknowledgement. */
	deliveredAt: string | null;
	deliveredSession: number | null;
	deliveredSubtaskId: string | null;
}

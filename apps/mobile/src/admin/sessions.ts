/** The live sign-ins of the organization, one entry per person. */

import type { MemberSession } from "./types";

export interface PersonSessions {
	userId: string;
	email: string | null;
	sessions: MemberSession[];
}

/** Sessions grouped by person, the person with the latest sign-in first, each person's latest first. */
export function byPerson(sessions: MemberSession[]): PersonSessions[] {
	const people = new Map<string, PersonSessions>();
	for (const session of [...sessions].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
		const person = people.get(session.user_id) ?? { userId: session.user_id, email: session.user_email, sessions: [] };
		person.sessions.push(session);
		people.set(session.user_id, person);
	}
	return [...people.values()];
}

/** A user agent, bounded to a line. */
export function deviceOf(userAgent: string | null): string | null {
	if (!userAgent) return null;
	const trimmed = userAgent.trim();
	return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed || null;
}

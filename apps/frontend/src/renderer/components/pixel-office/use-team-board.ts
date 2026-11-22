import { useCallback, useEffect, useRef, useState } from "react";
import type {
	TeamBoard,
	TeamBoardPeriod,
	TeamBoardResult,
	TeamBoardScope,
} from "../../../shared/types/pixel-office";

/**
 * The team leaderboard of a server project, read while the panel is open
 * (`PIXEL_OFFICE_TEAM_BOARD`). An answer that arrives for a project, scope or
 * period the person has since left is dropped. Saving the consent reads the
 * board again: the person's name appears or leaves at once.
 */
export function useTeamBoard(projectId: string, open: boolean) {
	const [scope, setScope] = useState<TeamBoardScope>("project");
	const [period, setPeriod] = useState<TeamBoardPeriod>("season");
	// The board read, with the project it is for: another project's is not shown.
	const [held, setHeld] = useState<{ projectId: string; board: TeamBoard } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const ask = useRef(0);

	const load = useCallback(() => {
		const api = globalThis.electronAPI?.pixelOffice;
		if (!api) return;
		const turn = ++ask.current;
		setLoading(true);
		setError(null);
		api
			.getTeamBoard(projectId, { scope, period })
			.catch((): TeamBoardResult => ({ success: false, error: "unreachable" }))
			.then((result) => {
				if (turn !== ask.current) return;
				setLoading(false);
				if (result.success) setHeld({ projectId, board: result.board });
				else setError(result.error);
			});
	}, [projectId, scope, period]);

	useEffect(() => {
		if (open) load();
	}, [open, load]);

	const setVisible = useCallback(
		async (visible: boolean) => {
			setSaving(true);
			// Only reached from a board the API answered, so the API is there.
			const result = await globalThis.electronAPI.pixelOffice
				.setTeamConsent(projectId, visible)
				.catch(() => null);
			setSaving(false);
			if (result?.success) load();
			else setError(result ? result.error : "unreachable");
		},
		[projectId, load],
	);

	const board = held?.projectId === projectId ? held.board : null;
	return { scope, setScope, period, setPeriod, board, error, loading, saving, setVisible };
}

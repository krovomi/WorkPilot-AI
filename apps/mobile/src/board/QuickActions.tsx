/**
 * A long press on a card of the board: what can be done to it right away,
 * without opening it. Only the steps the card screen runs without asking
 * twice (start, approve, stop, build again); merging, opening a pull request,
 * sending back and deleting stay on the card screen, behind its confirmation
 * and the app lock. "Open the card" is always there.
 *
 * The card is read again first (its spec, its approval, its runs), so the
 * choices are the ones the card screen would offer now; the server checks
 * each again.
 */

import { useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentRun, BoardCard, CardDetails } from "../api/types";
import { useApi, useSession } from "../auth/session";
import { describeError } from "../i18n";
import { ActionSheet, type SheetOption } from "../ui/ActionSheet";
import { done, failed, press } from "../ui/haptics";
import { ACTION_ICONS } from "./actionIcons";
import { boardColumn } from "./columns";
import { allowedActions, availableActions, type CardAction, runPhase, startCard, stopCard } from "./actions";

/** The actions a long press may run; everything else opens the card. */
export const QUICK_ACTIONS: ReadonlySet<CardAction> = new Set(["start", "approve", "stop", "retry"]);

const OPEN = "open";

interface Read {
	details: CardDetails | null;
	runs: AgentRun[];
}

export function useQuickActions(
	projectId: string,
	onChanged: () => Promise<void>,
): { open: (card: BoardCard) => void; sheet: ReactNode } {
	const { t } = useTranslation();
	const api = useApi();
	const { can } = useSession();
	const router = useRouter();
	const [card, setCard] = useState<BoardCard | null>(null);
	const [read, setRead] = useState<Read | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const open = (chosen: BoardCard) => {
		press();
		setCard(chosen);
		setRead(null);
		setError(null);
		void (async () => {
			try {
				const [details, runs] = await Promise.all([
					api.card(projectId, chosen.id),
					chosen.specId ? api.runs(projectId, chosen.specId) : Promise.resolve([]),
				]);
				setRead({ details, runs });
			} catch (err) {
				setRead({ details: null, runs: [] });
				setError(describeError(err));
			}
		})();
	};

	const close = () => setCard(null);
	// Read at each drawing: none while the card is being read.
	const details = read?.details ?? null;

	const actions: CardAction[] =
		card && read && !error
			? allowedActions(availableActions(card, read.details, read.runs), can).filter((a) => QUICK_ACTIONS.has(a))
			: [];
	const options: SheetOption[] = [
		...actions.map((action) => ({ key: action, label: t(`actions.${action}`), icon: ACTION_ICONS[action] })),
		{ key: OPEN, label: t("board.openCard"), icon: "arrow-right" },
	];

	const select = async (key: string) => {
		// Choices are only drawn while a card is open.
		const target = card as BoardCard;
		if (key === OPEN) {
			setCard(null);
			router.push({ pathname: "/projects/[projectId]/cards/[cardId]", params: { projectId, cardId: target.id } });
			return;
		}
		setBusy(key);
		setError(null);
		try {
			switch (key as CardAction) {
				case "start":
					await startCard(api, projectId, target, details);
					break;
				case "approve":
					await api.approve(projectId, target.id);
					break;
				case "stop":
					await stopCard(api, projectId, target);
					break;
				default:
					await runPhase(api, projectId, target, "build");
			}
			done();
			setCard(null);
			await onChanged();
		} catch (err) {
			failed();
			setError(describeError(err));
		} finally {
			setBusy(null);
		}
	};

	const sheet = (
		<ActionSheet
			visible={card !== null}
			title={card?.title ?? ""}
			subtitle={card ? `#${card.id.split("-")[0]} · ${t(`columns.${boardColumn(card)}`)}` : undefined}
			options={read ? options : []}
			loading={card !== null && read === null}
			busy={busy}
			error={error}
			closeLabel={t("common.close")}
			onSelect={(key) => void select(key)}
			onClose={close}
		/>
	);
	return { open, sheet };
}

import type React from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, UserPlus, X } from "lucide-react";
import type { ServerDelegation, ServerPerson } from "@shared/types/server-approval";
import { formatAppDate } from "../../lib/date-format";
import { CharterButton, Chip, Notice, Panel } from "../charter";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";

interface ServerDelegationsPanelProps {
	/** A server project's id. */
	readonly projectId: string;
}

/** A day picked in a date field, as the moment it starts or ends, in ISO 8601. */
export function dayBoundary(day: string, end: boolean): string | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
	const moment = new Date(`${day}T${end ? "23:59:00" : "00:00:00"}`);
	return Number.isNaN(moment.getTime()) ? undefined : moment.toISOString();
}

/**
 * The approvals lent on a server project (holidays, on-call): who lends to
 * whom, until when, and a form to lend one's own. The server checks the
 * colleague, the period and who may end one (`shared_board/approvals.py`).
 */
export function ServerDelegationsPanel({
	projectId,
}: ServerDelegationsPanelProps): React.ReactElement {
	const { t } = useTranslation(["specApproval"]);
	const [delegations, setDelegations] = useState<ServerDelegation[]>([]);
	const [people, setPeople] = useState<ServerPerson[]>([]);
	const [to, setTo] = useState("");
	const [starts, setStarts] = useState("");
	const [ends, setEnds] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = useId();

	const load = useCallback(async () => {
		const [lent, members] = await Promise.all([
			globalThis.electronAPI.listServerDelegations(projectId),
			globalThis.electronAPI.listServerDelegates(projectId),
		]);
		if (lent.success) setDelegations(lent.data ?? []);
		if (members.success) setPeople(members.data ?? []);
		const failed = !lent.success ? lent : !members.success ? members : null;
		setError(failed ? (failed.error ?? t("specApproval:delegations.loadFailed")) : null);
	}, [projectId, t]);

	useEffect(() => {
		void load();
	}, [load]);

	const endsAt = dayBoundary(ends, true);
	const startsAt = starts ? dayBoundary(starts, false) : undefined;
	const canLend = Boolean(to && endsAt && (!starts || startsAt)) && !busy;

	async function lend() {
		if (!endsAt) return;
		setBusy(true);
		try {
			const result = await globalThis.electronAPI.createServerDelegation(projectId, {
				toUserId: to,
				endsAt,
				...(startsAt ? { startsAt } : {}),
			});
			if (!result.success) {
				setError(result.error ?? t("specApproval:delegations.saveFailed"));
				return;
			}
			setTo("");
			setStarts("");
			setEnds("");
			await load();
		} finally {
			setBusy(false);
		}
	}

	async function end(id: string) {
		setBusy(true);
		try {
			const result = await globalThis.electronAPI.revokeServerDelegation(projectId, id);
			if (!result.success) {
				setError(result.error ?? t("specApproval:delegations.saveFailed"));
				return;
			}
			await load();
		} finally {
			setBusy(false);
		}
	}

	return (
		<Panel data-testid="server-delegations-panel">
			<span className="wp-kicker">{t("specApproval:delegations.heading")}</span>
			<p className="wp-meta mt-1">{t("specApproval:delegations.hint")}</p>
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="mt-2">
					{error}
				</Notice>
			)}
			{delegations.length === 0 ? (
				<p className="mt-2 text-sm">{t("specApproval:delegations.empty")}</p>
			) : (
				<ul className="mt-2 space-y-1 text-sm">
					{delegations.map((d) => (
						<li key={d.id} className="flex items-center justify-between gap-2">
							<span>
								{t("specApproval:delegations.item", {
									from: d.from.name,
									to: d.to.name,
									start: formatAppDate(d.startsAt),
									end: formatAppDate(d.endsAt),
								})}
							</span>
							<span className="flex items-center gap-1">
								<Chip tone={d.active ? "green" : "muted"}>
									{t(
										d.active
											? "specApproval:delegations.active"
											: "specApproval:delegations.planned",
									)}
								</Chip>
								<CharterButton
									size="sm"
									variant="ghost"
									icon={X}
									disabled={busy}
									aria-label={t("specApproval:delegations.end", { to: d.to.name })}
									onClick={() => void end(d.id)}
								/>
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="mt-3 grid gap-2 text-sm">
				<label className="grid gap-1" htmlFor={`${ids}-to`}>
					<span>{t("specApproval:delegations.to")}</span>
					<NativeSelect id={`${ids}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
						<option value="">{t("specApproval:delegations.pick")}</option>
						{people.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</NativeSelect>
				</label>
				<label className="grid gap-1" htmlFor={`${ids}-from`}>
					<span>{t("specApproval:delegations.from")}</span>
					<Input id={`${ids}-from`} type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
				</label>
				<label className="grid gap-1" htmlFor={`${ids}-until`}>
					<span>{t("specApproval:delegations.until")}</span>
					<Input id={`${ids}-until`} type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
				</label>
				<CharterButton icon={UserPlus} busy={busy} disabled={!canLend} onClick={() => void lend()}>
					{t("specApproval:delegations.lend")}
				</CharterButton>
			</div>
		</Panel>
	);
}

export default ServerDelegationsPanel;

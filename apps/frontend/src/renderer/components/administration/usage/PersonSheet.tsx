/**
 * One person's sheet: their figures, tokens per day, what they did (action
 * names, runs and jobs, never their content) and the pages they opened. A
 * platform administrator can erase the account here, once its address is
 * typed back; the totals stay, without a name.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageEvent,
	UsagePersonSheet,
	UsageQuery,
	UsageResult,
} from "@shared/types/server-usage";
import { Button, Input, Label } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import { usePermissionsStore } from "@/stores/permissions-store";
import type { Loaded } from "./use-usage-view";
import { DailyChart, KeyFigures, PagesTable, Section, Shown } from "./UsageSections";

function api() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

/** A call's answer as a view's state. */
export function loadedOf<T>(result: UsageResult<T>): Loaded<T> {
	return result.ok
		? { data: result.data, error: null, loading: false }
		: { data: null, error: result.error, loading: false };
}

export const WAITING = { data: null, error: null, loading: true } as const;

function Timeline({ events }: { readonly events: readonly UsageEvent[] }) {
	const { t } = useTranslation("administration");
	if (events.length === 0) {
		return <p className="text-xs text-muted-foreground">{t("usage.dashboard.empty")}</p>;
	}
	return (
		<ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
			{events.map((event) => (
				<li key={`${event.at}-${event.kind}-${event.what}`} className="flex flex-wrap gap-2">
					<span className="w-36 shrink-0 text-xs text-muted-foreground">
						{formatAppDateTime(event.at)}
					</span>
					<span className="text-xs font-semibold">{t(`usage.person.kinds.${event.kind}`)}</span>
					<span className="font-mono text-xs">{event.what}</span>
					{event.status && (
						<span className="text-xs text-muted-foreground">{event.status}</span>
					)}
					{event.project && <span className="text-xs text-muted-foreground">{event.project}</span>}
					{event.model && <span className="text-xs text-muted-foreground">{event.model}</span>}
				</li>
			))}
		</ul>
	);
}

/** The sheet's sections, shared with the person's own view in Settings. */
export function SheetBody({ sheet }: { readonly sheet: UsagePersonSheet }) {
	const { t } = useTranslation("administration");
	return (
		<div className="space-y-4">
			<KeyFigures summary={sheet.summary} />
			<Section title={t("usage.dashboard.dailyTitle")}>
				<DailyChart rows={sheet.daily} />
			</Section>
			<Section title={t("usage.person.timeline")}>
				<Timeline events={sheet.timeline} />
			</Section>
			<Section title={t("usage.dashboard.pagesTitle")}>
				<PagesTable report={sheet.pages} />
			</Section>
		</div>
	);
}

function Erase({ userId, onErased }: { readonly userId: string; readonly onErased: () => void }) {
	const { t } = useTranslation("administration");
	const [email, setEmail] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function erase() {
		const bridge = api();
		if (!bridge) return;
		setBusy(true);
		const result = await bridge.eraseAccount(userId, email);
		setBusy(false);
		if (result.ok) onErased();
		else setError(result.error);
	}

	return (
		<Section title={t("usage.person.erase.title")}>
			<p className="text-sm text-muted-foreground">{t("usage.person.erase.what")}</p>
			<div className="flex flex-wrap items-end gap-2">
				<div className="space-y-1">
					<Label htmlFor="erase-email">{t("usage.person.erase.confirm")}</Label>
					<Input
						id="erase-email"
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
				</div>
				<Button
					variant="destructive"
					disabled={busy || email.trim().length < 3}
					onClick={() => void erase()}
				>
					{t("usage.person.erase.button")}
				</Button>
			</div>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error })}
				</p>
			)}
		</Section>
	);
}

export function PersonSheet({
	personId,
	query,
	onBack,
}: {
	readonly personId: string;
	readonly query: UsageQuery;
	readonly onBack: () => void;
}) {
	const { t } = useTranslation("administration");
	const isPlatformAdmin = usePermissionsStore((s) => s.isPlatformAdmin);
	const [sheet, setSheet] = useState<Loaded<UsagePersonSheet>>(WAITING);
	const [erased, setErased] = useState(false);
	const key = JSON.stringify(query);

	useEffect(() => {
		const bridge = api();
		if (!bridge) return;
		let live = true;
		void bridge.getUsagePerson(personId, JSON.parse(key) as UsageQuery).then((result) => {
			if (live) setSheet(loadedOf(result));
		});
		return () => {
			live = false;
		};
	}, [personId, key]);

	return (
		<div className="space-y-4">
			<Button size="sm" variant="outline" onClick={onBack}>
				{t("usage.person.back")}
			</Button>
			{erased ? (
				<p role="status" className="text-sm text-muted-foreground">
					{t("usage.person.erase.done")}
				</p>
			) : (
				<Shown loaded={sheet}>
					{(data) => (
						<>
							<div>
								<h3 className="text-base font-semibold">{data.user.name ?? data.user.email}</h3>
								{data.user.email && (
									<p className="text-xs text-muted-foreground">{data.user.email}</p>
								)}
							</div>
							<SheetBody sheet={data} />
							{isPlatformAdmin && (
								<Erase userId={data.user.user_id} onErased={() => setErased(true)} />
							)}
						</>
					)}
				</Shown>
			)}
		</div>
	);
}

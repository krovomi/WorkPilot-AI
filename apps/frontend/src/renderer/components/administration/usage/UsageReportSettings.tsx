/**
 * The organization's usage report (`usage.read` to read, `usage.write` to
 * change or send): when it goes and in which time zone, on which days, in
 * which language, whether it names people, and to whom. An address outside the
 * organization is flagged, never refused, since a manager who is not on the
 * server may read it. The last sends show what went out; "Send now" sends the
 * last daily report at once. The server checks the permission and the values
 * again; this pane only offers what it would accept.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageReportSettings as Settings,
	UsageReportSettingsUpdate,
} from "@shared/types/server-usage";
import { Button, Input, Label, NativeSelect, Textarea } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import { usePermission } from "@/stores/permissions-store";
import { UsageReportPreview } from "./UsageReportPreview";
import { formatCount, formatDay } from "./usage-format";

const MAX_RECIPIENTS = 20;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;

type Status = "loading" | "ready" | "saving" | "saved";
type Form = Omit<UsageReportSettingsUpdate, "recipients"> & { recipients: string };

function api() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

function zones(): string[] {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
}

function formOf(settings: Settings): Form {
	return {
		enabled: settings.enabled,
		time: settings.time,
		timezone: settings.timezone,
		days: settings.days,
		recipients: settings.recipients.map((r) => r.address).join("\n"),
		language: settings.language,
		names: settings.names,
		weekly: settings.weekly,
		monthly: settings.monthly,
	};
}

/** The addresses typed, one per line, or null when one does not read. */
export function addressesOf(text: string): string[] | null {
	const found = text
		.split(/[\n,;]/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (found.length > MAX_RECIPIENTS) return null;
	return found.every((a) => a.length <= 254 && EMAIL.test(a)) ? found : null;
}

function Toggle({
	checked,
	disabled,
	onChange,
	children,
}: {
	readonly checked: boolean;
	readonly disabled: boolean;
	readonly onChange: (checked: boolean) => void;
	readonly children: ReactNode;
}) {
	return (
		<label className="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
			/>
			{children}
		</label>
	);
}

export function UsageReportSettings() {
	const { t } = useTranslation("administration");
	const canWrite = usePermission("usage.write");
	const [settings, setSettings] = useState<Settings | null>(null);
	const [form, setForm] = useState<Form | null>(null);
	const [status, setStatus] = useState<Status>("loading");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [sent, setSent] = useState<string | null>(null);

	const show = useCallback((next: Settings) => {
		setSettings(next);
		setForm(formOf(next));
	}, []);

	const load = useCallback(async () => {
		const result = await api()?.getReportSettings();
		if (!result) return;
		if (result.ok) show(result.data);
		else setError(result.error);
		setStatus("ready");
	}, [show]);

	useEffect(() => {
		void load();
	}, [load]);

	if (status === "loading" || !form || !settings) {
		return error ? (
			<p role="alert" className="text-sm text-destructive">
				{t("usage.failed", { error })}
			</p>
		) : (
			<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
		);
	}

	const shown: Form = form;
	const change = (patch: Partial<Form>) => {
		setForm({ ...shown, ...patch });
		if (status === "saved") setStatus("ready");
	};
	const recipients = addressesOf(form.recipients);
	const timeValid = TIME.test(form.time) && ZONE.test(form.timezone);
	const valid = recipients !== null && timeValid && form.days.length > 0;
	const outside = settings.recipients.filter((r) => !r.member).map((r) => r.address);
	const disabled = !canWrite;

	async function save() {
		const bridge = api();
		if (!bridge || recipients === null) return;
		setStatus("saving");
		setError(null);
		const result = await bridge.setReportSettings({ ...shown, recipients });
		if (result.ok) {
			show(result.data);
			setStatus("saved");
		} else {
			setError(result.error);
			setStatus("ready");
		}
	}

	async function sendNow() {
		const bridge = api();
		if (!bridge) return;
		setSending(true);
		setSent(null);
		setError(null);
		const result = await bridge.sendReportNow();
		setSending(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		setSent(
			result.data.status === "sent"
				? t("usage.report.sent", { count: result.data.recipients })
				: t("usage.report.notSent", {
						status: t(`usage.report.statuses.${result.data.status}`, {
							defaultValue: result.data.status,
						}),
					}),
		);
		await load();
	}

	const toggleDay = (day: number, on: boolean) => {
		const days = on ? [...shown.days, day] : shown.days.filter((d) => d !== day);
		change({ days: [...new Set(days)].sort((a, b) => a - b) });
	};
	const readers = settings.default_recipients.join(", ") || t("usage.report.noReader");

	return (
		<div className="max-w-3xl space-y-6">
			<p className="text-sm text-muted-foreground">{t("usage.report.description")}</p>
			{!settings.email_enabled && (
				<p role="status" className="text-sm text-warning">
					{t("usage.report.noSmtp")}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error })}
				</p>
			)}

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">{t("usage.report.when")}</h3>
				<Toggle checked={form.enabled} disabled={disabled} onChange={(enabled) => change({ enabled })}>
					{t("usage.report.enabled")}
				</Toggle>
				<div className="flex flex-wrap gap-4">
					<div className="space-y-1">
						<Label htmlFor="report-time">{t("usage.report.time")}</Label>
						<Input
							id="report-time"
							type="time"
							disabled={disabled}
							value={form.time}
							onChange={(e) => change({ time: e.target.value })}
						/>
					</div>
					<div className="min-w-64 space-y-1">
						<Label htmlFor="report-zone">{t("usage.report.timezone")}</Label>
						<Input
							id="report-zone"
							list="report-zones"
							disabled={disabled}
							value={form.timezone}
							onChange={(e) => change({ timezone: e.target.value.trim() })}
						/>
						<datalist id="report-zones">
							{zones().map((zone) => (
								<option key={zone} value={zone} />
							))}
						</datalist>
					</div>
				</div>
				{!timeValid && <p className="text-xs text-destructive">{t("usage.report.invalidTime")}</p>}
				<fieldset className="space-y-1">
					<legend className="text-sm font-medium">{t("usage.report.days")}</legend>
					<div className="flex flex-wrap gap-3">
						{WEEKDAYS.map((day) => (
							<Toggle
								key={day}
								checked={form.days.includes(day)}
								disabled={disabled}
								onChange={(on) => toggleDay(day, on)}
							>
								{t(`usage.report.weekdays.${day}`)}
							</Toggle>
						))}
					</div>
					{form.days.length === 0 && (
						<p className="text-xs text-destructive">{t("usage.report.noDay")}</p>
					)}
				</fieldset>
				<Toggle checked={form.weekly} disabled={disabled} onChange={(weekly) => change({ weekly })}>
					{t("usage.report.weekly")}
				</Toggle>
				<Toggle checked={form.monthly} disabled={disabled} onChange={(monthly) => change({ monthly })}>
					{t("usage.report.monthly")}
				</Toggle>
			</section>

			<section className="space-y-3">
				<h3 className="text-sm font-semibold">{t("usage.report.content")}</h3>
				<div className="max-w-xs space-y-1">
					<Label htmlFor="report-language">{t("usage.report.language")}</Label>
					<NativeSelect
						id="report-language"
						disabled={disabled}
						value={form.language}
						onChange={(e) => change({ language: e.target.value === "en" ? "en" : "fr" })}
					>
						<option value="fr">{t("usage.report.languages.fr")}</option>
						<option value="en">{t("usage.report.languages.en")}</option>
					</NativeSelect>
				</div>
				<Toggle checked={form.names} disabled={disabled} onChange={(names) => change({ names })}>
					{t("usage.report.names")}
				</Toggle>
				<p className="text-xs text-muted-foreground">{t("usage.report.namesHint")}</p>
			</section>

			<section className="space-y-2">
				<Label htmlFor="report-recipients">{t("usage.report.recipients")}</Label>
				<Textarea
					id="report-recipients"
					rows={4}
					disabled={disabled}
					value={form.recipients}
					onChange={(e) => change({ recipients: e.target.value })}
				/>
				<p className={recipients === null ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
					{recipients === null
						? t("usage.report.invalidRecipients", { max: MAX_RECIPIENTS })
						: t("usage.report.recipientsHint", { max: MAX_RECIPIENTS })}
				</p>
				{recipients !== null && recipients.length === 0 && (
					<p className="text-xs text-muted-foreground">
						{t("usage.report.defaultRecipients", { list: readers })}
					</p>
				)}
				{outside.map((address) => (
					<p key={address} role="status" className="text-xs text-warning">
						{t("usage.report.outside", { address })}
					</p>
				))}
			</section>

			{canWrite && (
				<div className="flex flex-wrap items-center gap-3">
					<Button onClick={() => void save()} disabled={!valid || status === "saving"}>
						{t("common.save")}
					</Button>
					{status === "saved" && (
						<span role="status" className="text-xs text-muted-foreground">
							{t("usage.saved")}
						</span>
					)}
					<Button
						variant="outline"
						onClick={() => void sendNow()}
						disabled={sending || !settings.email_enabled}
						title={t("usage.report.sendNowHint")}
					>
						{t("usage.report.sendNow")}
					</Button>
					{sent && (
						<span role="status" className="text-xs text-muted-foreground">
							{sent}
						</span>
					)}
				</div>
			)}

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("usage.report.lastSends")}</h3>
				{settings.last_sends.length ? (
					<table className="w-full text-sm">
						<thead className="text-left text-xs text-muted-foreground">
							<tr>
								<th className="py-1 font-medium">{t("usage.report.sentAt")}</th>
								<th className="py-1 font-medium">{t("usage.report.kind")}</th>
								<th className="py-1 font-medium">{t("usage.report.status")}</th>
								<th className="py-1 text-right font-medium">{t("usage.report.recipientCount")}</th>
							</tr>
						</thead>
						<tbody>
							{settings.last_sends.map((send) => (
								<tr key={`${send.at}-${send.kind}`} className="border-t border-border">
									<td className="py-1">{formatAppDateTime(send.at)}</td>
									<td className="py-1">
										{t(`usage.report.kinds.${send.kind}`, { defaultValue: send.kind })}
										<span className="ml-2 text-muted-foreground">{formatDay(send.period)}</span>
									</td>
									<td className="py-1">
										{t(`usage.report.statuses.${send.status}`, { defaultValue: send.status })}
									</td>
									<td className="py-1 text-right">{formatCount(send.recipients)}</td>
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<p className="text-sm text-muted-foreground">{t("usage.report.noSends")}</p>
				)}
			</section>

			<UsageReportPreview />
		</div>
	);
}

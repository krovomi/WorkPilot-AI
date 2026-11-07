/**
 * "Needs you" for a server account: the person's own ntfy, Telegram or Teams
 * channel, on which the server tells them a card waits for them (a plan to
 * approve, work to review, a run stopped on an error).
 *
 * A secret is typed here and sent once. The server stores it encrypted and
 * only says it is set; leaving a secret field empty keeps the stored one
 * (`main/server-needs-you.ts`).
 */

import { BellRing, Check, Loader2, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AVAILABLE_LANGUAGES } from "../../../shared/constants/i18n";
import {
	NEEDS_YOU_EVENTS,
	type NeedsYouChannelKind,
	type NeedsYouEventKind,
	type ServerNeedsYouChannelInput,
	type ServerNeedsYouOverview,
	type ServerNeedsYouTestResult,
} from "../../../shared/types/server-needs-you";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { randomTopic } from "./NeedsYouChannels";

import { NativeSelect } from "../ui/native-select";
type Drafts = Record<NeedsYouChannelKind, Record<string, string>>;

/** Each channel's fields, in order; a secret is a password field, never prefilled. */
const FIELDS: Record<NeedsYouChannelKind, { name: string; secret: boolean }[]> = {
	ntfy: [
		{ name: "server", secret: false },
		{ name: "topic", secret: true },
		{ name: "access_token", secret: true },
	],
	telegram: [
		{ name: "bot_token", secret: true },
		{ name: "chat_id", secret: false },
	],
	teams: [{ name: "webhook_url", secret: true }],
};
const CHANNELS = Object.keys(FIELDS) as NeedsYouChannelKind[];

const EMPTY: Drafts = { ntfy: {}, telegram: {}, teams: {} };

export function ServerNeedsYouSettings() {
	const { t } = useTranslation("settings");
	const [overview, setOverview] = useState<ServerNeedsYouOverview | null>(null);
	const [drafts, setDrafts] = useState<Drafts>(EMPTY);
	const [enabled, setEnabled] = useState<Record<NeedsYouChannelKind, boolean>>({
		ntfy: true,
		telegram: true,
		teams: true,
	});
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tested, setTested] = useState<Partial<Record<NeedsYouChannelKind, ServerNeedsYouTestResult>>>(
		{},
	);

	const refresh = useCallback(async () => {
		const result = await window.electronAPI.serverAuth.getNeedsYou();
		if (!result.success || !result.data) {
			setError(result.error ?? t("serverNeedsYou.unavailable"));
			return;
		}
		const data = result.data;
		setOverview(data);
		setEnabled({
			ntfy: data.channels.ntfy.enabled ?? true,
			telegram: data.channels.telegram.enabled ?? true,
			teams: data.channels.teams.enabled ?? true,
		});
		// The non-secret fields come back as stored; the secret ones stay empty.
		setDrafts({
			ntfy: { server: data.channels.ntfy.server ?? "" },
			telegram: { chat_id: data.channels.telegram.chat_id ?? "" },
			teams: {},
		});
	}, [t]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const run = useCallback(
		async (key: string, action: () => Promise<{ success: boolean; error?: string }>) => {
			setError(null);
			setBusy(key);
			try {
				const result = await action();
				if (!result.success) setError(result.error ?? t("serverNeedsYou.unavailable"));
				await refresh();
			} finally {
				setBusy(null);
			}
		},
		[refresh, t],
	);

	const setDraft = (channel: NeedsYouChannelKind, name: string, value: string) =>
		setDrafts((current) => ({ ...current, [channel]: { ...current[channel], [name]: value } }));

	const save = (channel: NeedsYouChannelKind) => {
		const input: ServerNeedsYouChannelInput & Record<string, unknown> = {
			enabled: enabled[channel],
		};
		for (const field of FIELDS[channel]) {
			const value = (drafts[channel][field.name] ?? "").trim();
			// An empty secret keeps the stored one; an empty plain field is sent.
			if (value || !field.secret) input[field.name] = value;
		}
		return run(`save-${channel}`, () =>
			window.electronAPI.serverAuth.saveNeedsYouChannel(channel, input),
		);
	};

	const test = async (channel: NeedsYouChannelKind) => {
		setError(null);
		setBusy(`test-${channel}`);
		try {
			const result = await window.electronAPI.serverAuth.testNeedsYouChannel(channel);
			if (result.success && result.data) {
				setTested((current) => ({ ...current, [channel]: result.data }));
			} else setError(result.error ?? t("serverNeedsYou.unavailable"));
		} finally {
			setBusy(null);
		}
	};

	const savePreferences = (events: Record<NeedsYouEventKind, boolean>, locale: "en" | "fr") =>
		run("preferences", () =>
			window.electronAPI.serverAuth.saveNeedsYouPreferences({ events, locale }),
		);

	return (
		<div className="space-y-6">
			<div>
				<h3 className="flex items-center gap-2 text-lg font-semibold">
					<BellRing className="h-5 w-5" />
					{t("serverNeedsYou.title")}
				</h3>
				<p className="text-sm text-muted-foreground">{t("serverNeedsYou.description")}</p>
			</div>
			{overview && !overview.available && (
				<p className="rounded-md border border-border bg-muted/50 p-3 text-sm">
					{t("serverNeedsYou.offOnServer")}
				</p>
			)}
			{overview && !overview.vault && (
				<p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
					{t("serverNeedsYou.noVault")}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			{overview && (
				<div className="space-y-3 rounded-lg border border-border p-4">
					<Label className="font-medium">{t("serverNeedsYou.moments")}</Label>
					{NEEDS_YOU_EVENTS.map((event) => (
						<div key={event} className="flex items-center justify-between gap-3">
							<span className="text-sm">{t(`serverNeedsYou.events.${event}`)}</span>
							<Switch
								aria-label={t(`serverNeedsYou.events.${event}`)}
								checked={overview.events[event]}
								disabled={busy !== null}
								onCheckedChange={(checked) =>
									savePreferences({ ...overview.events, [event]: checked }, overview.locale)
								}
							/>
						</div>
					))}
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor="server-needs-you-locale" className="text-sm font-normal">
							{t("serverNeedsYou.language")}
						</Label>
						<NativeSelect
							id="server-needs-you-locale"
							className="px-2 py-1 text-sm h-auto"
							value={overview.locale}
							disabled={busy !== null}
							onChange={(e) =>
								savePreferences(overview.events, e.target.value === "fr" ? "fr" : "en")
							}
						>
							{AVAILABLE_LANGUAGES.map((lang) => (
								<option key={lang.value} value={lang.value}>
									{lang.nativeLabel}
								</option>
							))}
						</NativeSelect>
					</div>
				</div>
			)}

			{overview &&
				CHANNELS.map((channel) => {
					const shown = overview.channels[channel];
					return (
						<div key={channel} className="space-y-3 rounded-lg border border-border p-4">
							<div className="flex items-center justify-between gap-3">
								<div className="space-y-1">
									<Label className="flex items-center gap-2 font-medium">
										{t(`serverNeedsYou.${channel}.title`)}
										{shown.configured && (
											<span className="flex items-center gap-1 text-xs text-success">
												<Check className="h-3 w-3" />
												{t("serverNeedsYou.stored")}
											</span>
										)}
									</Label>
									<p className="text-sm text-muted-foreground">
										{t(`serverNeedsYou.${channel}.description`)}
									</p>
								</div>
								<Switch
									aria-label={t("serverNeedsYou.enabled", {
										channel: t(`serverNeedsYou.${channel}.title`),
									})}
									checked={enabled[channel]}
									onCheckedChange={(checked) =>
										setEnabled((current) => ({ ...current, [channel]: checked }))
									}
								/>
							</div>
							{shown.configured && shown.readable === false && (
								<p className="text-sm text-destructive">{t("serverNeedsYou.unreadable")}</p>
							)}
							{FIELDS[channel].map((field) => {
								const id = `server-needs-you-${channel}-${field.name}`;
								const isSet = field.secret && Boolean(shown[field.name as keyof typeof shown]);
								return (
									<div key={field.name} className="space-y-1">
										<Label htmlFor={id} className="text-sm font-normal">
											{t(`serverNeedsYou.${channel}.${field.name}`)}
										</Label>
										<div className="flex gap-2">
											<Input
												id={id}
												type={field.secret ? "password" : "text"}
												autoComplete="off"
												placeholder={
													isSet
														? t("serverNeedsYou.replacePlaceholder")
														: t(`serverNeedsYou.${channel}.${field.name}Placeholder`)
												}
												value={drafts[channel][field.name] ?? ""}
												onChange={(e) => setDraft(channel, field.name, e.target.value)}
											/>
											{channel === "ntfy" && field.name === "topic" && (
												<Button
													variant="outline"
													onClick={() => setDraft("ntfy", "topic", randomTopic())}
												>
													{t("serverNeedsYou.ntfy.generate")}
												</Button>
											)}
										</div>
									</div>
								);
							})}
							<div className="flex flex-wrap items-center gap-2">
								<Button
									onClick={() => save(channel)}
									disabled={busy !== null || overview.vault === false}
								>
									{busy === `save-${channel}` && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
									{t("serverNeedsYou.save")}
								</Button>
								{shown.configured && (
									<>
										<Button
											variant="outline"
											onClick={() => test(channel)}
											disabled={busy !== null || !overview.available}
										>
											<Send className="mr-2 h-4 w-4" />
											{t("serverNeedsYou.test")}
										</Button>
										<Button
											variant="outline"
											onClick={() =>
												run(`delete-${channel}`, () =>
													window.electronAPI.serverAuth.deleteNeedsYouChannel(channel),
												)
											}
											disabled={busy !== null}
											aria-label={t("serverNeedsYou.remove", {
												channel: t(`serverNeedsYou.${channel}.title`),
											})}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									</>
								)}
								{tested[channel] && (
									<span className="text-sm text-muted-foreground">
										{t(`serverNeedsYou.results.${tested[channel]}`)}
									</span>
								)}
							</div>
						</div>
					);
				})}
		</div>
	);
}

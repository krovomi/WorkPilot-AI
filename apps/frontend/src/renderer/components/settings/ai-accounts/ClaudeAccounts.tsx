/**
 * Claude's accounts: its OAuth profiles (`ClaudeProfileManager`), each signed
 * in in its own config folder by the embedded login terminal. The active
 * profile is the default the tasks start on; automatic failover can move a
 * stopped task to the next one (the "Automatic failover" tab).
 */

import type { ClaudeProfile } from "@shared/types";
import { claudeAccountKey } from "@shared/types/ai-account-usage";
import { Check, Loader2, LogIn, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { useAiAccountUsageStore } from "@/stores/ai-account-usage-store";
import { loadClaudeProfiles, useClaudeProfileStore } from "@/stores/claude-profile-store";
import { Chip, Notice } from "../../charter";
import { AuthTerminal } from "../AuthTerminal";
import { AccountSpend } from "./AccountSpend";

interface SignIn {
	terminalId: string;
	configDir: string;
	profileName: string;
}

/** The folder name of a new profile: letters, digits and dashes. */
export function claudeProfileSlug(name: string): string {
	return name
		.toLowerCase()
		.replaceAll(/[^a-z0-9]/g, "-")
		.replaceAll(/-+/g, "-")
		.replaceAll(/^-|-$/g, "");
}

export function ClaudeAccounts() {
	const { t } = useTranslation("settings");
	const profiles = useClaudeProfileStore((s) => s.profiles);
	const activeProfileId = useClaudeProfileStore((s) => s.activeProfileId);
	const [newName, setNewName] = useState("");
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [signIn, setSignIn] = useState<SignIn | null>(null);

	useEffect(() => {
		void loadClaudeProfiles();
		void useAiAccountUsageStore.getState().load();
	}, []);

	const run = useCallback(
		async (key: string, action: () => Promise<{ success: boolean; error?: string }>, fallback: string) => {
			setBusy(key);
			setError(null);
			try {
				const result = await action();
				if (!result.success) setError(result.error || fallback);
				await loadClaudeProfiles();
				return result.success;
			} catch (err) {
				setError(err instanceof Error ? err.message : fallback);
				return false;
			} finally {
				setBusy(null);
			}
		},
		[],
	);

	const startSignIn = async (profile: Pick<ClaudeProfile, "id" | "name">) => {
		setBusy(profile.id);
		setError(null);
		try {
			const result = await globalThis.electronAPI.authenticateClaudeProfile(profile.id);
			if (result.success && result.data) {
				setSignIn({ ...result.data, profileName: profile.name });
			} else {
				setError(result.error || t("aiAccounts.accounts.claude.signInFailed"));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : t("aiAccounts.accounts.claude.signInFailed"));
		} finally {
			setBusy(null);
		}
	};

	const add = async () => {
		const name = newName.trim();
		const slug = claudeProfileSlug(name);
		if (!slug) {
			setError(t("aiAccounts.accounts.claude.invalidName"));
			return;
		}
		setBusy("add");
		setError(null);
		try {
			const result = await globalThis.electronAPI.saveClaudeProfile({
				id: `profile-${Date.now()}`,
				name,
				configDir: `~/.claude-profiles/${slug}`,
				isDefault: false,
				createdAt: new Date(),
			});
			await loadClaudeProfiles();
			if (!result.success || !result.data) {
				setError(result.error || t("aiAccounts.accounts.saveFailed"));
				return;
			}
			setNewName("");
			setAdding(false);
			setBusy(null);
			await startSignIn(result.data);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("aiAccounts.accounts.saveFailed"));
		} finally {
			setBusy(null);
		}
	};

	const makeDefault = (id: string) =>
		run(
			id,
			async () => {
				const result = await globalThis.electronAPI.setActiveClaudeProfile(id);
				// The header's usage follows the new account.
				if (result.success) globalThis.electronAPI.requestAllProfilesUsage?.();
				return result;
			},
			t("aiAccounts.accounts.defaultFailed"),
		);

	const rename = async () => {
		if (!renaming?.name.trim()) return;
		const { id, name } = renaming;
		const done = await run(
			id,
			() => globalThis.electronAPI.renameClaudeProfile(id, name.trim()),
			t("aiAccounts.accounts.saveFailed"),
		);
		if (done) setRenaming(null);
	};

	const remove = async (profile: ClaudeProfile) => {
		const confirmed = await confirmAction({
			title: t("aiAccounts.accounts.deleteTitle", { name: profile.name }),
			description: t("aiAccounts.accounts.claude.deleteDescription"),
			destructive: true,
		});
		if (!confirmed) return;
		await run(
			profile.id,
			() => globalThis.electronAPI.deleteClaudeProfile(profile.id),
			t("aiAccounts.accounts.deleteFailed"),
		);
	};

	return (
		<div className="space-y-3" data-testid="claude-accounts">
			<p className="text-sm text-muted-foreground">{t("aiAccounts.accounts.claude.intro")}</p>
			{error && (
				<Notice tone="red" role="alert">
					{error}
				</Notice>
			)}
			{profiles.length === 0 && <p className="text-sm text-muted-foreground">{t("aiAccounts.accounts.empty")}</p>}

			{profiles.map((profile) => {
				const isDefault = profile.id === activeProfileId;
				const signedIn = profile.isAuthenticated !== false;
				const isRenaming = renaming?.id === profile.id;
				return (
					<div
						key={profile.id}
						data-testid="ai-account"
						data-account={profile.id}
						className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
					>
						<div className="min-w-0 flex-1 space-y-0.5">
							{isRenaming ? (
								<form
									className="flex items-center gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										void rename();
									}}
								>
									<Input
										aria-label={t("aiAccounts.accounts.name")}
										value={renaming.name}
										maxLength={80}
										autoFocus
										onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })}
									/>
									<Button type="submit" size="sm" variant="outline" aria-label={t("aiAccounts.accounts.save")}>
										<Check className="h-4 w-4" />
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										aria-label={t("aiAccounts.accounts.cancel")}
										onClick={() => setRenaming(null)}
									>
										<X className="h-4 w-4" />
									</Button>
								</form>
							) : (
								<div className="flex items-center gap-2 text-sm font-medium">
									<span className="truncate">{profile.name}</span>
									{isDefault && (
										<Chip tone="accent" dot={false}>
											{t("aiAccounts.accounts.default")}
										</Chip>
									)}
								</div>
							)}
							<p className={signedIn ? "text-xs text-muted-foreground" : "text-xs text-warning"}>
								{signedIn
									? profile.email || t("aiAccounts.accounts.claude.signedIn")
									: t("aiAccounts.accounts.claude.signedOut")}
							</p>
							<AccountSpend accountKey={claudeAccountKey(profile.id)} />
						</div>
						<div className="flex flex-wrap gap-2">
							{!isDefault && signedIn && (
								<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => makeDefault(profile.id)}>
									<Star className="mr-2 h-4 w-4" />
									{t("aiAccounts.accounts.useByDefault")}
								</Button>
							)}
							<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => startSignIn(profile)}>
								{busy === profile.id ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<LogIn className="mr-2 h-4 w-4" />
								)}
								{signedIn ? t("aiAccounts.accounts.claude.reconnect") : t("aiAccounts.accounts.claude.signIn")}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={t("aiAccounts.accounts.rename", { name: profile.name })}
								onClick={() => setRenaming({ id: profile.id, name: profile.name })}
							>
								<Pencil className="h-4 w-4" />
							</Button>
							{!profile.isDefault && (
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									aria-label={t("aiAccounts.accounts.delete", { name: profile.name })}
									onClick={() => remove(profile)}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							)}
						</div>
					</div>
				);
			})}

			{signIn && (
				<div className="h-80 overflow-hidden rounded-lg border border-border">
					<AuthTerminal
						terminalId={signIn.terminalId}
						configDir={signIn.configDir}
						profileName={signIn.profileName}
						onClose={() => setSignIn(null)}
						onAuthSuccess={() => {
							setSignIn(null);
							void loadClaudeProfiles();
						}}
					/>
				</div>
			)}

			{adding ? (
				<form
					className="space-y-3 rounded-lg border border-border p-4"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<div className="space-y-2">
						<Label htmlFor="claude-account-name">{t("aiAccounts.accounts.name")}</Label>
						<Input
							id="claude-account-name"
							value={newName}
							maxLength={80}
							placeholder={t("aiAccounts.accounts.namePlaceholder")}
							onChange={(event) => setNewName(event.target.value)}
						/>
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" disabled={busy === "add"} onClick={() => setAdding(false)}>
							{t("aiAccounts.accounts.cancel")}
						</Button>
						<Button type="submit" disabled={busy === "add" || !newName.trim()}>
							{busy === "add" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
							{t("aiAccounts.accounts.claude.addAndSignIn")}
						</Button>
					</div>
				</form>
			) : (
				<Button variant="outline" onClick={() => setAdding(true)} disabled={signIn !== null}>
					<Plus className="mr-2 h-4 w-4" />
					{t("aiAccounts.accounts.add")}
				</Button>
			)}
		</div>
	);
}

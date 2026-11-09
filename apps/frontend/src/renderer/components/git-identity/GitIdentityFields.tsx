import { UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface GitIdentityDraft {
	name: string;
	email: string;
}

export const EMPTY_GIT_IDENTITY: GitIdentityDraft = { name: "", email: "" };

/** Enough to send: the main process checks it again before saving it. */
export function isGitIdentityComplete(draft: GitIdentityDraft): boolean {
	return draft.name.trim() !== "" && /^[^\s@]+@[^\s@]+$/.test(draft.email.trim());
}

interface GitIdentityFieldsProps {
	readonly value: GitIdentityDraft;
	readonly onChange: (value: GitIdentityDraft) => void;
	/** Prefix of the inputs' ids, unique on the page. */
	readonly idPrefix: string;
}

/**
 * The name and email git asks for before a first commit, shown when the
 * machine has none (a fresh install): without them "Initialize Git" failed
 * with git's raw "Author identity unknown" message.
 */
export function GitIdentityFields({ value, onChange, idPrefix }: GitIdentityFieldsProps) {
	const { t } = useTranslation("dialogs");
	return (
		<div className="rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-3">
			<div className="flex items-start gap-3">
				<UserRound className="h-5 w-5 text-warning mt-0.5 shrink-0" />
				<div className="space-y-1">
					<p className="font-medium text-sm">{t("gitSetup.identity.title")}</p>
					<p className="text-xs text-muted-foreground">{t("gitSetup.identity.body")}</p>
				</div>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor={`${idPrefix}-git-name`}>{t("gitSetup.identity.name")}</Label>
					<Input
						id={`${idPrefix}-git-name`}
						autoComplete="name"
						placeholder={t("gitSetup.identity.namePlaceholder")}
						value={value.name}
						onChange={(e) => onChange({ ...value, name: e.target.value })}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`${idPrefix}-git-email`}>{t("gitSetup.identity.email")}</Label>
					<Input
						id={`${idPrefix}-git-email`}
						type="email"
						autoComplete="email"
						placeholder={t("gitSetup.identity.emailPlaceholder")}
						value={value.email}
						onChange={(e) => onChange({ ...value, email: e.target.value })}
					/>
				</div>
			</div>
			<p className="text-xs text-muted-foreground">{t("gitSetup.identity.hint")}</p>
		</div>
	);
}

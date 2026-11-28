import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { errorLabel } from "./lifecycle-labels";

interface MaintainersEditorProps {
	readonly projectId: string;
	readonly maintainers: string[];
	/** The lists of a module, a team or a branch (`team:x`, `branch:y`). */
	readonly scopes?: Record<string, string[]>;
	readonly onSaved: () => void;
}

interface Draft {
	/** "" is the list at the top, for every pair no scoped list covers. */
	scope: string;
	names: string;
	/** A list for a scope that has none yet: the scope is typed too. */
	adding: boolean;
}

/** Who settles a conflict that flip-flops: names or e-mails, kept in the vault. */
export function MaintainersEditor({ projectId, maintainers, scopes = {}, onSaved }: MaintainersEditorProps) {
	const { t } = useTranslation(["context"]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = async ({ scope, names: text }: Draft) => {
		const names = text
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		const where = scope.trim();
		const result = where
			? await window.electronAPI.setMemoryMaintainers(projectId, names, where)
			: await window.electronAPI.setMemoryMaintainers(projectId, names);
		if (result.success) {
			setDraft(null);
			setError(null);
			onSaved();
		} else {
			setError(errorLabel(t, result.error));
		}
	};

	const edit = (scope: string, names: string[]) => setDraft({ scope, names: names.join(", "), adding: false });
	const scoped = Object.entries(scopes);

	return (
		<div className="space-y-2 text-xs text-muted-foreground" data-testid="memory-maintainers">
			<div className="flex flex-wrap items-center gap-2">
				<ShieldCheck className="h-3.5 w-3.5" />
				<span>
					{maintainers.length > 0
						? t("context:lifecycle.maintainers.list", { names: maintainers.join(", ") })
						: t("context:lifecycle.maintainers.none")}
				</span>
				{draft === null && (
					<Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => edit("", maintainers)}>
						{t("context:lifecycle.maintainers.edit")}
					</Button>
				)}
			</div>
			{scoped.map(([scope, names]) => (
				<div key={scope} className="flex flex-wrap items-center gap-2 pl-5" data-testid="memory-maintainers-scope">
					<span>{t("context:lifecycle.maintainers.scoped", { scope, names: names.join(", ") })}</span>
					{draft === null && (
						<Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => edit(scope, names)}>
							{t("context:lifecycle.maintainers.edit")}
						</Button>
					)}
				</div>
			))}
			{draft === null && (
				<Button
					size="sm"
					variant="ghost"
					className="h-6 px-2 text-xs"
					onClick={() => setDraft({ scope: "", names: "", adding: true })}
				>
					{t("context:lifecycle.maintainers.addScope")}
				</Button>
			)}
			{draft !== null && (
				<div className="flex flex-wrap gap-2">
					{draft.adding && (
						<Input
							className="w-48"
							value={draft.scope}
							maxLength={200}
							placeholder={t("context:lifecycle.maintainers.scopePlaceholder")}
							aria-label={t("context:lifecycle.maintainers.scopePlaceholder")}
							onChange={(event) => setDraft({ ...draft, scope: event.target.value })}
						/>
					)}
					<Input
						className="min-w-48 flex-1"
						value={draft.names}
						placeholder={t("context:lifecycle.maintainers.placeholder")}
						aria-label={t("context:lifecycle.maintainers.placeholder")}
						onChange={(event) => setDraft({ ...draft, names: event.target.value })}
					/>
					<Button size="sm" disabled={draft.adding && !draft.scope.trim()} onClick={() => save(draft)}>
						{t("context:lifecycle.maintainers.save")}
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
						{t("context:lifecycle.maintainers.cancel")}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}

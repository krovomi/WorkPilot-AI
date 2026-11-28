import { AlertTriangle, KeyRound } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TrustedSigner } from "../../../../shared/types";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { errorLabel } from "./lifecycle-labels";

interface SignersEditorProps {
	readonly projectId: string;
	readonly signers: TrustedSigner[];
	/** Changes to the list someone pushed that no listed key signed. */
	readonly rejected: number;
	/** Whether this machine's git signs its commits. */
	readonly signing: boolean;
	/** The maintainers edit the list when there are some. */
	readonly canEdit: boolean;
	/** The memories no trusted key signed. */
	readonly unverified: number;
	readonly onSaved: () => void;
}

/** The keys whose signed notes reach the agents, kept in the vault. */
export function SignersEditor({
	projectId,
	signers,
	rejected,
	signing,
	canEdit,
	unverified,
	onSaved,
}: SignersEditorProps) {
	const { t } = useTranslation(["context"]);
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const save = async (text: string) => {
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		const result = await window.electronAPI.setMemorySigners(projectId, lines);
		if (result.success) {
			setDraft(null);
			setError(null);
			onSaved();
		} else if (result.error === "maintainer-only") {
			setError(t("context:lifecycle.signers.maintainerOnly"));
		} else {
			setError(errorLabel(t, result.error));
		}
	};

	// The keys themselves are not shown back: a name and a fingerprint say which key.
	const names = signers.map((signer) => `${signer.name} (${signer.kind})`).join(", ");

	return (
		<div className="space-y-2 text-xs text-muted-foreground" data-testid="memory-signers">
			<div className="flex flex-wrap items-center gap-2">
				<KeyRound className="h-3.5 w-3.5" />
				<span>
					{signers.length > 0
						? t("context:lifecycle.signers.list", { names })
						: t("context:lifecycle.signers.none")}
				</span>
				{draft === null && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-xs"
						disabled={!canEdit}
						onClick={() => setDraft("")}
					>
						{t("context:lifecycle.signers.edit")}
					</Button>
				)}
			</div>
			<p>{t("context:lifecycle.signers.hint")}</p>
			{!canEdit && <p>{t("context:lifecycle.signers.maintainerOnly")}</p>}
			{signers.length > 0 && unverified > 0 && (
				<p data-testid="memory-signers-unverified">
					{t("context:lifecycle.signers.unverified", { count: unverified })}
				</p>
			)}
			{rejected > 0 && (
				<p className="flex items-center gap-2 text-warning">
					<AlertTriangle className="h-3.5 w-3.5" />
					{t("context:lifecycle.signers.rejected", { count: rejected })}
				</p>
			)}
			{signers.length > 0 && !signing && (
				<p className="text-warning" data-testid="memory-signers-not-signing">
					{t("context:lifecycle.signers.notSigning")}
				</p>
			)}
			{draft !== null && (
				<div className="space-y-2">
					<Textarea
						value={draft}
						rows={4}
						className="font-mono text-xs"
						placeholder={t("context:lifecycle.signers.placeholder")}
						aria-label={t("context:lifecycle.signers.placeholder")}
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="flex gap-2">
						<Button size="sm" onClick={() => save(draft)}>
							{t("context:lifecycle.signers.save")}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
							{t("context:lifecycle.signers.cancel")}
						</Button>
					</div>
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

import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { copyTextToClipboard } from "./terminal-interactions";

interface TerminalAuthLinkBarProps {
	/**
	 * L'URL de connexion repérée dans le terminal. Les appelants la passent aussi
	 * en `key` : une nouvelle URL est une nouvelle tentative, et ni le « copié »
	 * ni l'échec de la précédente ne la décrivent.
	 */
	readonly url: string;
}

/**
 * L'URL de connexion, hors du terminal, avec de quoi l'ouvrir et la copier.
 *
 * Une URL OAuth fait trois lignes de quatre-vingts colonnes : la cliquer
 * suppose de viser le bon fragment, la copier suppose de sélectionner trois
 * fragments dont la césure tombe au milieu d'un `%3A`. Les liens du terminal
 * fonctionnent de nouveau, mais ils restent un mauvais endroit où viser — et
 * c'est le seul geste qui débloque l'authentification.
 *
 * Le bandeau n'apparaît que quand une URL de connexion est affichée : un
 * bandeau permanent qui ne dit rien est un bandeau que personne ne lit.
 */
export function TerminalAuthLinkBar({ url }: TerminalAuthLinkBarProps) {
	const { t } = useTranslation("common");
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	const handleOpen = useCallback(async () => {
		setError(null);
		try {
			await window.electronAPI?.openExternal?.(url);
		} catch (openError) {
			// Le repli Linux vit déjà derrière openExternal ; s'il a échoué, il n'y
			// a plus rien à essayer et le dire vaut mieux qu'un bouton muet.
			setError(
				openError instanceof Error ? openError.message : String(openError),
			);
		}
	}, [url]);

	const handleCopy = useCallback(async () => {
		setError(null);
		const ok = await copyTextToClipboard(url);
		setCopied(ok);
		if (!ok) setError(t("authTerminal.copyFailed"));
	}, [url, t]);

	return (
		<div className="px-3 py-2 border-t border-border bg-primary/5 space-y-1">
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-muted-foreground shrink-0">
					{t("authTerminal.signInLink")}
				</span>
				<code
					className="flex-1 min-w-0 truncate text-xs font-mono select-all"
					title={url}
				>
					{url}
				</code>
				<Button
					variant="outline"
					size="sm"
					className="h-7 shrink-0"
					onClick={handleCopy}
				>
					{copied ? (
						<Check className="h-3.5 w-3.5 mr-1" />
					) : (
						<Copy className="h-3.5 w-3.5 mr-1" />
					)}
					{copied ? t("authTerminal.linkCopied") : t("authTerminal.copyLink")}
				</Button>
				<Button
					variant="default"
					size="sm"
					className="h-7 shrink-0"
					onClick={handleOpen}
				>
					<ExternalLink className="h-3.5 w-3.5 mr-1" />
					{t("authTerminal.openInBrowser")}
				</Button>
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

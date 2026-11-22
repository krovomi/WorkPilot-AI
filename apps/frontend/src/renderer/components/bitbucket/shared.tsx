/**
 * Pieces both Bitbucket views use: the state a view shows when the project
 * has no working Bitbucket settings, a person's name, a date line and a link
 * that opens bitbucket.org in the browser (through the main process, which
 * keeps its own list of allowed protocols).
 */

import { ExternalLink, GitBranch, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BitbucketUser } from "../../../shared/types";
import { formatAppDateTime } from "../../lib/date-format";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";

export function NotConnected({
	error,
	onOpenSettings,
}: {
	readonly error?: string | null;
	readonly onOpenSettings?: () => void;
}) {
	const { t } = useTranslation("bitbucket");
	return (
		<EmptyState
			icon={GitBranch}
			title={t("notConnected.title")}
			description={error || t("notConnected.description")}
			action={
				onOpenSettings && (
					<Button variant="outline" onClick={onOpenSettings}>
						<Settings2 className="h-4 w-4 mr-2" />
						{t("notConnected.openSettings")}
					</Button>
				)
			}
		/>
	);
}

/** "Alice · 02/11/2026 16:30", or the date alone. */
export function byLine(user: BitbucketUser | undefined, date: string): string {
	const when = formatAppDateTime(date);
	return user?.displayName ? `${user.displayName} · ${when}` : when;
}

export function OpenInBitbucket({ url }: { readonly url: string }) {
	const { t } = useTranslation("bitbucket");
	if (!url) return null;
	return (
		<Button variant="ghost" size="sm" onClick={() => void window.electronAPI.openExternal(url)}>
			<ExternalLink className="h-4 w-4 mr-1" />
			{t("openInBitbucket")}
		</Button>
	);
}

/**
 * The notice of what the server measures (server mode), shown once to each
 * member of an organization, and again when page activity is turned on. The
 * server records that it was read (`usage.notice.seen`), with what was
 * measured then: the proof the person was told (RGPD article 13).
 */
import { useTranslation } from "react-i18next";
import type { UsageNotice as Notice } from "@shared/types/server-usage";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui";

export function UsageNoticeDialog({
	notice,
	onClose,
}: {
	readonly notice: Notice | null;
	readonly onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<Dialog open={notice !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("usageNotice.title")}</DialogTitle>
					<DialogDescription>{t("usageNotice.intro")}</DialogDescription>
				</DialogHeader>
				{notice && (
					<div className="space-y-3 text-sm">
						<ul className="list-disc space-y-1 pl-5">
							{notice.measured.map((what) => (
								<li key={what}>{t(`usageNotice.measured.${what}`)}</li>
							))}
							{notice.page_activity && <li>{t("usageNotice.measured.pages")}</li>}
						</ul>
						<p>{t("usageNotice.never")}</p>
						<p>{t("usageNotice.retention", { days: notice.usage_retention_days })}</p>
						{notice.page_activity && (
							<p>
								{t("usageNotice.pageRetention", { days: notice.page_activity_retention_days })}
							</p>
						)}
						<p>{t("usageNotice.visibleTo", { roles: notice.visible_to.join(", ") })}</p>
						<p className="text-muted-foreground">{t("usageNotice.rights")}</p>
					</div>
				)}
				<DialogFooter>
					<Button onClick={onClose}>{t("usageNotice.understood")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

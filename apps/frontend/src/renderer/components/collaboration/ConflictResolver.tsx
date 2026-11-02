/**
 * A card edit that met a teammate's change of the same field (server mode):
 * both versions side by side, and the person keeps theirs or the teammate's.
 * Shown by the edit dialog when the server card changed while it was open.
 */

import { AlertTriangle, Check, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CardEditConflict } from "../../../shared/types";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";

interface ConflictResolverProps {
	conflicts: CardEditConflict[];
	open: boolean;
	busy?: boolean;
	onKeepMine: () => void;
	onKeepTheirs: () => void;
	onClose: () => void;
}

export function ConflictResolver({
	conflicts,
	open,
	busy = false,
	onKeepMine,
	onKeepTheirs,
	onClose,
}: ConflictResolverProps) {
	const { t } = useTranslation("collaboration");
	return (
		<Dialog open={open && conflicts.length > 0} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="h-5 w-5 text-amber-500" />
						{t("conflicts.detected")}
					</DialogTitle>
					<DialogDescription>{t("conflicts.description")}</DialogDescription>
				</DialogHeader>

				<div className="max-h-[50vh] space-y-4 overflow-y-auto">
					{conflicts.map((conflict) => (
						<div key={conflict.field} className="space-y-2">
							<p className="text-sm font-medium">{t(`conflicts.field.${conflict.field}`)}</p>
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-1">
									<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
										{t("conflicts.yourVersion")}
									</h4>
									<pre className="whitespace-pre-wrap wrap-break-word rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
										{conflict.mine}
									</pre>
								</div>
								<div className="space-y-1">
									<h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
										{t("conflicts.theirVersion")}
									</h4>
									<pre className="whitespace-pre-wrap wrap-break-word rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
										{conflict.theirs}
									</pre>
								</div>
							</div>
						</div>
					))}
				</div>

				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
					<Button variant="outline" className="gap-2" disabled={busy} onClick={onKeepTheirs}>
						<Users className="h-4 w-4" />
						{t("conflicts.keepTheirs")}
					</Button>
					<Button className="gap-2" disabled={busy} onClick={onKeepMine}>
						<Check className="h-4 w-4" />
						{t("conflicts.keepMine")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}

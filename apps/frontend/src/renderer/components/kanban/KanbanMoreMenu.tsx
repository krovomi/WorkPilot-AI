import { HardDrive, MoreHorizontal, Network } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openMultiRepoDialog } from "@/stores/multi-repo-store";
import { MultiRepoDialog } from "../multi-repo/MultiRepoDialog";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { WorktreePurgeDialog } from "./WorktreePurgeDialog";

/**
 * The board's occasional actions, behind one "⋯" button so the toolbar keeps
 * to a single line: a change across several repositories (one card per
 * repository) and the purge of finished worktrees. Both run on this
 * computer, so the toolbar shows the menu on local boards only.
 */
export function KanbanMoreMenu({ projectId }: { readonly projectId: string }) {
	const { t } = useTranslation(["tasks", "multiRepo"]);
	const [purgeOpen, setPurgeOpen] = useState(false);
	return (
		<>
			{/* Not modal: a dialog opened from an item must get the focus and the pointer. */}
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8 rounded-full text-muted-foreground transition-colors hover:text-foreground"
						aria-label={t("tasks:kanban.more.label")}
						title={t("tasks:kanban.more.label")}
						data-testid="kanban-more-menu"
					>
						<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					<DropdownMenuItem
						className="items-start gap-2.5 py-2"
						onSelect={() => openMultiRepoDialog(projectId)}
					>
						<Network className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
						<span className="flex flex-col gap-0.5">
							<span className="font-medium">{t("multiRepo:button.label")}</span>
							<span className="text-xs text-muted-foreground">{t("multiRepo:button.title")}</span>
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="items-start gap-2.5 py-2"
						onSelect={() => setPurgeOpen(true)}
						data-testid="worktree-purge-button"
					>
						<HardDrive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
						<span className="flex flex-col gap-0.5">
							<span className="font-medium">{t("tasks:purge.button")}</span>
							<span className="text-xs text-muted-foreground">{t("tasks:purge.buttonTitle")}</span>
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<MultiRepoDialog />
			{purgeOpen && (
				<WorktreePurgeDialog projectId={projectId} onClose={() => setPurgeOpen(false)} />
			)}
		</>
	);
}

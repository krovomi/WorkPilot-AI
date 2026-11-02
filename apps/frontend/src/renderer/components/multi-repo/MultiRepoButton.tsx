import { Network } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openMultiRepoDialog } from "@/stores/multi-repo-store";
import { Button } from "../ui/button";
import { MultiRepoDialog } from "./MultiRepoDialog";

/**
 * The board's entry to multi-repo tasks: a change that spans several
 * repositories, each run as a card of its own project. Local boards only: a
 * server project's cards run on the server.
 */
export function MultiRepoButton({ projectId }: { readonly projectId: string }) {
	const { t } = useTranslation(["multiRepo"]);
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="h-8 gap-2 rounded-full text-muted-foreground transition-colors hover:text-foreground"
				title={t("multiRepo:button.title")}
				onClick={() => openMultiRepoDialog(projectId)}
			>
				<Network className="h-4 w-4" aria-hidden="true" />
				{t("multiRepo:button.label")}
			</Button>
			<MultiRepoDialog />
		</>
	);
}

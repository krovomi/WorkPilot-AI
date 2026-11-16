/**
 * Azure DevOps import dialog props. The work item and sync types live in
 * `shared/types/integrations.ts`.
 */

export interface AzureDevOpsImportModalProps {
	readonly projectId: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onImportComplete?: () => void;
}

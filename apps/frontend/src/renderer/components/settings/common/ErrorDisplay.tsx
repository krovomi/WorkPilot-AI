import { AlertCircle } from "lucide-react";
import { Notice } from "../../charter";

interface ErrorDisplayProps {
	error: string | null;
	envError?: string | null;
}

/**
 * Displays error messages in a consistent format.
 * Combines general errors and environment configuration errors.
 */
export function ErrorDisplay({ error, envError }: ErrorDisplayProps) {
	const displayError = error || envError;

	if (!displayError) {
		return null;
	}

	return (
		<Notice tone="red" icon={AlertCircle} role="alert" className="mt-4">
			{displayError}
		</Notice>
	);
}

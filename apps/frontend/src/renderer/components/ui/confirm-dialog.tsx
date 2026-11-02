/**
 * Confirm dialog — the app's replacement for `window.confirm`.
 *
 * `window.confirm` opens an OS dialog titled with the page URL, ignores the
 * theme and the language, and blocks the renderer. `confirmAction()` returns
 * the same yes/no answer as a promise, shown in the app's AlertDialog:
 *
 *   if (!(await confirmAction({ title, description, destructive: true }))) return;
 *
 * `<ConfirmDialogHost />` renders the pending request; the Toaster mounts it,
 * so every window that shows toasts can also ask.
 */
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./alert-dialog";
import { buttonVariants } from "./button";

export interface ConfirmOptions {
	title: React.ReactNode;
	description?: React.ReactNode;
	/** Label of the confirm button. Defaults to "Confirm" (or "Delete" when destructive). */
	confirmLabel?: string;
	cancelLabel?: string;
	/** Red confirm button, for deletions and other actions that cannot be undone. */
	destructive?: boolean;
}

interface Pending extends ConfirmOptions {
	resolve: (confirmed: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<(request: Pending | null) => void>();

function publish(next: Pending | null): void {
	pending = next;
	for (const listener of listeners) listener(next);
}

/**
 * Ask the user to confirm. Resolves `true` on confirm, `false` on cancel,
 * Escape or a click outside. A second request answers the first with `false`.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
	pending?.resolve(false);
	return new Promise<boolean>((resolve) => {
		publish({ ...options, resolve });
	});
}

function answer(confirmed: boolean): void {
	const current = pending;
	if (!current) return;
	publish(null);
	current.resolve(confirmed);
}

export function ConfirmDialogHost() {
	const { t } = useTranslation("common");
	const [request, setRequest] = React.useState<Pending | null>(pending);

	React.useEffect(() => {
		listeners.add(setRequest);
		return () => {
			listeners.delete(setRequest);
		};
	}, []);

	const confirmLabel =
		request?.confirmLabel ??
		(request?.destructive ? t("buttons.delete") : t("buttons.confirm"));

	return (
		<AlertDialog
			open={request !== null}
			onOpenChange={(open) => {
				if (!open) answer(false);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{request?.title}</AlertDialogTitle>
					{request?.description ? (
						<AlertDialogDescription className="whitespace-pre-line">
							{request.description}
						</AlertDialogDescription>
					) : null}
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={() => answer(false)}>
						{request?.cancelLabel ?? t("buttons.cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						className={
							request?.destructive
								? buttonVariants({ variant: "destructive" })
								: undefined
						}
						onClick={() => answer(true)}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

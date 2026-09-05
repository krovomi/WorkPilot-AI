/**
 * One place that owns pulling a model onto the local LLM server.
 *
 * Before this hook, every surface that could start a download (the phase model
 * selector, the onboarding picker, the Hugging Face discovery page) had its own
 * copy of "ensure the server is up, call pullOllamaModel, remember to update
 * the store" — and each copy forgot a different part of it. The task panel's
 * copy, in particular, only ran inside the dropdown's `onValueChange`, so a
 * model that was already selected and still missing could not be downloaded at
 * all: re-picking the value the `<Select>` already holds fires no change event.
 *
 * What this guarantees:
 *
 *  - **Non-blocking.** `download()` returns as soon as the pull is under way.
 *    The download itself runs in the main process, so closing the task panel,
 *    switching view or reloading the window does not stop it, and the shared
 *    download store keeps rendering it in the global indicator.
 *  - **Idempotent.** Asking twice for the same model attaches to the running
 *    pull instead of starting a second one.
 *  - **Reported.** A toast on start and on completion, an error the user can
 *    act on when it fails, and silence when the user cancelled it themselves.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./use-toast";
import { useDownloadStore } from "../stores/download-store";
import { useSettingsStore } from "../stores/settings-store";

/** Sentinel the main process resolves with when the user aborted the pull. */
export const PULL_CANCELLED = "PULL_CANCELLED";

export interface OllamaModelDownload {
	/** Start (or join) the download of `model`. Resolves once it settles. */
	download: (model: string) => Promise<boolean>;
	/** Abort an in-flight download of `model`. */
	cancel: (model: string) => void;
	/** True while `model` is downloading. */
	isDownloading: (model: string) => boolean;
	/** 0-100 for a model being downloaded, `null` when it isn't. */
	progressOf: (model: string) => number | null;
	/** The last error for `model`, if its download failed. */
	errorOf: (model: string) => string | null;
}

export function useOllamaModelDownload(options?: {
	/** Called after a successful pull, to refresh the caller's model list. */
	onDownloaded?: (model: string) => void;
}): OllamaModelDownload {
	const { t } = useTranslation(["tasks"]);
	const { toast } = useToast();
	const downloads = useDownloadStore((s) => s.downloads);
	const startDownload = useDownloadStore((s) => s.startDownload);
	const completeDownload = useDownloadStore((s) => s.completeDownload);
	const failDownload = useDownloadStore((s) => s.failDownload);
	const cancelDownload = useDownloadStore((s) => s.cancelDownload);

	// The server the model has to land ON. Without this the pull went to
	// localhost:11434 while the run talked to the configured host — the model
	// downloaded successfully and was still missing where it was needed.
	const baseUrl = useSettingsStore((s) =>
		(s.settings?.globalOllamaApiUrl ?? "").trim(),
	);

	const onDownloaded = options?.onDownloaded;

	const download = useCallback(
		async (model: string): Promise<boolean> => {
			const name = model.trim();
			if (!name) return false;

			// Read the live store rather than the render-time snapshot: two rapid
			// clicks would both see the same stale `downloads` object.
			if (useDownloadStore.getState().isDownloading(name)) return false;

			const api = globalThis.electronAPI;
			if (!api?.pullOllamaModel) {
				toast({
					title: t("tasks:logs.model.downloadFailedTitle", "Download failed"),
					description: t(
						"tasks:logs.model.downloadUnavailable",
						"Model downloads are only available in the desktop app.",
					),
					variant: "destructive",
				});
				return false;
			}

			startDownload(name);
			toast({
				title: t("tasks:logs.model.downloadStartedTitle", "Downloading model"),
				description: t(
					"tasks:logs.model.downloadStartedDesc",
					"{{model}} is downloading in the background.",
					{ model: name },
				),
			});

			try {
				// The server has to be up before it can be asked to pull anything;
				// `ensureOllama` installs the portable binary on first use and starts
				// the daemon. A failure here is reported as-is — "the download did
				// not start" is a different problem from "the download failed".
				const ensured = await api.ensureOllama?.(baseUrl || undefined);
				if (ensured && !ensured.success) {
					const message =
						ensured.error ||
						t(
							"tasks:logs.model.serverUnavailable",
							"The local Ollama server could not be started.",
						);
					failDownload(name, message);
					toast({
						title: t("tasks:logs.model.downloadFailedTitle", "Download failed"),
						description: message,
						variant: "destructive",
					});
					return false;
				}

				const res = await api.pullOllamaModel(name, baseUrl || undefined);
				if (res?.success) {
					completeDownload(name);
					toast({
						title: t("tasks:logs.model.downloadDoneTitle", "Model ready"),
						description: t(
							"tasks:logs.model.downloadDoneDesc",
							"{{model}} is installed and ready to use.",
							{ model: name },
						),
					});
					onDownloaded?.(name);
					return true;
				}

				const error = res?.error || "";
				if (error === PULL_CANCELLED) {
					// The user stopped it on purpose — no error toast for that.
					cancelDownload(name);
					return false;
				}
				failDownload(name, error);
				toast({
					title: t("tasks:logs.model.downloadFailedTitle", "Download failed"),
					description:
						error ||
						t(
							"tasks:logs.model.downloadFailedDesc",
							"{{model}} could not be downloaded.",
							{ model: name },
						),
					variant: "destructive",
				});
				return false;
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				failDownload(name, message);
				toast({
					title: t("tasks:logs.model.downloadFailedTitle", "Download failed"),
					description: message,
					variant: "destructive",
				});
				return false;
			}
		},
		[
			t,
			toast,
			baseUrl,
			startDownload,
			completeDownload,
			failDownload,
			cancelDownload,
			onDownloaded,
		],
	);

	const cancel = useCallback(
		(model: string) => {
			const name = model.trim();
			if (!name) return;
			// Mark it cancelled straight away so the UI stops offering "cancel" for
			// a pull that is already winding down; the main process confirms with a
			// terminal broadcast.
			cancelDownload(name);
			void globalThis.electronAPI?.cancelOllamaPull?.(name);
		},
		[cancelDownload],
	);

	const isDownloading = useCallback(
		(model: string) => {
			const d = downloads[model.trim()];
			return d?.status === "starting" || d?.status === "downloading";
		},
		[downloads],
	);

	const progressOf = useCallback(
		(model: string) => {
			const d = downloads[model.trim()];
			if (!d || (d.status !== "starting" && d.status !== "downloading")) {
				return null;
			}
			return d.percentage;
		},
		[downloads],
	);

	const errorOf = useCallback(
		(model: string) => {
			const d = downloads[model.trim()];
			return d?.status === "failed" ? (d.error ?? "") : null;
		},
		[downloads],
	);

	return { download, cancel, isDownloading, progressOf, errorOf };
}

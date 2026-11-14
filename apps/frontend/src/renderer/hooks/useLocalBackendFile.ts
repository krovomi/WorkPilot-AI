import { useEffect, useState } from "react";
import { localBackendObjectUrl } from "../lib/local-backend";

/**
 * A file the local backend serves, as a `blob:` URL for an `<img>`, a
 * `<video>` or a download link; `undefined` while it loads or when it could
 * not be read. A backend path starts with `/`; anything else (a `data:` URL,
 * an URL already usable) is returned as is. The blob is released on unmount.
 */
export function useLocalBackendFile(url: string | null | undefined): string | undefined {
	const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
	const passThrough = !url || !url.startsWith("/");

	useEffect(() => {
		if (!url || passThrough) return;
		const controller = new AbortController();
		let created: string | null = null;
		localBackendObjectUrl(url, controller.signal)
			.then((value) => {
				created = value;
				if (!controller.signal.aborted) setObjectUrl(value ?? undefined);
				else if (value) URL.revokeObjectURL(value);
			})
			.catch(() => {
				if (!controller.signal.aborted) setObjectUrl(undefined);
			});
		return () => {
			controller.abort();
			if (created) URL.revokeObjectURL(created);
			setObjectUrl(undefined);
		};
	}, [url, passThrough]);

	return passThrough ? (url ?? undefined) : objectUrl;
}

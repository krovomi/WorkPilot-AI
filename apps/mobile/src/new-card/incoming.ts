/**
 * Reads what another app shared with this one, once. `expo-sharing` keeps the
 * system's share (Android `SEND` intent; an iOS share extension once it is
 * enabled) until it is cleared; it is cleared here so the same text never
 * fills a second card. Only the raw payloads are read: the resolving variant
 * would fetch a shared link, and the app never loads one.
 */

import { clearSharedPayloads, getSharedPayloads } from "expo-sharing";
import { Platform } from "react-native";
import { draftFromShare, type ShareDraft } from "./share";

export function readIncomingShare(): ShareDraft | null {
	if (Platform.OS === "web") return null;
	try {
		const draft = draftFromShare(getSharedPayloads());
		clearSharedPayloads();
		return draft;
	} catch {
		return null;
	}
}

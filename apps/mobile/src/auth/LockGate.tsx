/**
 * Holds the signed-in screens behind the app lock when the person turned it
 * on (`lock.ts`): at launch, and when the app comes back after
 * `RELOCK_AFTER_MS` in the background. Also shares the lock settings with the
 * settings screen, so a change applies at once.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, StyleSheet, Text, View } from "react-native";
import { Button } from "../ui/components";
import { SPACE, useTheme } from "../ui/theme";
import { authenticate, canAsk, DEFAULT_LOCK, type LockSettings, loadLockSettings, RELOCK_AFTER_MS, saveLockSettings } from "./lock";

interface LockContext {
	settings: LockSettings;
	/** Whether this phone can ask at all (biometrics or a passcode). */
	available: boolean;
	update: (settings: LockSettings) => Promise<void>;
}

const Context = createContext<LockContext>({
	settings: DEFAULT_LOCK,
	available: false,
	update: async () => undefined,
});

export function useLock(): LockContext {
	return useContext(Context);
}

export function LockGate({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	const theme = useTheme();
	const [settings, setSettings] = useState<LockSettings | null>(null);
	const [available, setAvailable] = useState(false);
	const [locked, setLocked] = useState(true);
	const [failed, setFailed] = useState(false);
	const asking = useRef(false);
	const backgroundSince = useRef<number | null>(null);
	// The prompt's words, read when it opens: a language change does not re-run the lock.
	const words = useRef(t);
	words.current = t;

	const unlock = useCallback(async () => {
		if (asking.current) return;
		asking.current = true;
		setFailed(false);
		try {
			const ok = await authenticate(words.current("lock.prompt"), words.current("common.cancel"));
			setLocked(!ok);
			setFailed(!ok);
		} finally {
			asking.current = false;
		}
	}, []);

	useEffect(() => {
		let alive = true;
		void Promise.all([loadLockSettings(), canAsk()]).then(([loaded, can]) => {
			if (!alive) return;
			setSettings(loaded);
			setAvailable(can);
			if (loaded.atLaunch && can) void unlock();
			else setLocked(false);
		});
		return () => {
			alive = false;
		};
	}, [unlock]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "background") {
				backgroundSince.current = Date.now();
				return;
			}
			if (state !== "active") return;
			const since = backgroundSince.current;
			backgroundSince.current = null;
			if (!settings?.atLaunch || !available || since === null) return;
			if (Date.now() - since >= RELOCK_AFTER_MS) {
				setLocked(true);
				void unlock();
			}
		});
		return () => subscription.remove();
	}, [settings, available, unlock]);

	const update = useCallback(async (next: LockSettings) => {
		await saveLockSettings(next);
		setSettings(next);
	}, []);

	if (!settings) return null;
	return (
		<Context.Provider value={{ settings, available, update }}>
			<View
				style={styles.fill}
				importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
				accessibilityElementsHidden={locked}
			>
				{children}
			</View>
			{locked ? (
				// Over the screens, not instead of them: unlocking returns to where the person was.
				<View
					accessibilityViewIsModal
					style={[StyleSheet.absoluteFill, styles.locked, { backgroundColor: theme.background }]}
				>
					<Text style={{ color: theme.text, fontSize: 18, fontWeight: "600" }}>{t("lock.title")}</Text>
					{failed ? <Text style={{ color: theme.textMuted }}>{t("lock.failed")}</Text> : null}
					<Button label={t("lock.unlock")} onPress={() => void unlock()} />
				</View>
			) : null}
		</Context.Provider>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	locked: { flex: 1, alignItems: "center", justifyContent: "center", gap: SPACE.lg, padding: SPACE.lg },
});

/** Whether the app is in the foreground: a screen stops its reads and its stream in the background. */

import { useEffect, useState } from "react";
import { AppState } from "react-native";

export function useAppActive(): boolean {
	const [active, setActive] = useState(AppState.currentState === "active");
	useEffect(() => {
		const sub = AppState.addEventListener("change", (state) => setActive(state === "active"));
		return () => sub.remove();
	}, []);
	return active;
}

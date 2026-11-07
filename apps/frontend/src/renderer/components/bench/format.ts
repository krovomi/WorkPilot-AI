/** How the bench's numbers read, in its view and on a card's engine step. */

export function percent(value: number | null | undefined): string {
	return typeof value === "number" ? `${Math.round(value * 100)} %` : "—";
}

export function dollars(value: number | null | undefined): string {
	return typeof value === "number" ? `$${value.toFixed(2)}` : "—";
}

export function minutes(value: number | null | undefined): string {
	return typeof value === "number" ? `${Math.round(value / 60)} min` : "—";
}

/**
 * What the main process hands the renderer in place of a stored secret (a
 * project token, a webhook URL). The renderer is not trusted (rule S6): it
 * learns that a secret is set, never its value. Sent back unchanged — the
 * settings screens save the whole config on every edit — it means "keep the
 * stored value". Its character never occurs in a token or a URL, so a value
 * that still contains it is the mask, possibly with something typed after it.
 */
export const MASKED_SECRET = "••••••••";
export const MASKED_SECRET_CHAR = "•";

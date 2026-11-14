import "i18next";

/**
 * i18next 27 turned `strictInterpolationChecks` on by default. Our resources are
 * not declared as types (keys are plain strings), so the check has nothing to
 * check and only breaks the many `(key: string, options?) => string` helpers that
 * receive `t`. Keep the v26 `t()` types, as the 27.0.0 migration guide suggests.
 */
declare module "i18next" {
	interface CustomTypeOptions {
		strictInterpolationChecks: false;
	}
}

/**
 * Console helpers that no-op in production builds.
 *
 * Diagnostic chatter — mirror-race timings, cache-pill firing, the
 * basemap availability probe, per-attempt Overpass fallbacks — is
 * invaluable while developing but is pure noise in the deployed app, and
 * a console full of yellow warnings erodes trust ("is the app broken?").
 *
 * `import.meta.env.DEV` is `true` under `vite dev` and `false` in the
 * built bundle, so these collapse to no-ops in production. Genuine
 * user-facing errors should still use `console.error`/`console.warn`
 * directly — these are only for developer-facing breadcrumbs.
 */
export const IS_DEV = import.meta.env.DEV;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const devLog = (...args: any[]): void => {
    if (IS_DEV) console.log(...args);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const devWarn = (...args: any[]): void => {
    if (IS_DEV) console.warn(...args);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const devInfo = (...args: any[]): void => {
    if (IS_DEV) console.info(...args);
};

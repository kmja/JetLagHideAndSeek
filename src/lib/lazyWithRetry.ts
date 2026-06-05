/**
 * lazyWithRetry — `React.lazy` wrapper that retries the dynamic
 * import once with a small backoff before giving up.
 *
 * Why: SPA deploys rotate chunk hashes (Map-XXXX.js, etc). An
 * open tab with the previous deploy's index.html cached by the
 * service worker may try to dynamic-import a chunk hash that's
 * already been replaced server-side. The first import() rejects
 * with a ChunkLoadError; a second import() — usually after the
 * SW has been silently updated in the background — succeeds.
 * Without this wrapper the React tree throws straight to the
 * nearest error boundary and the user has to manually reload.
 * With it, the common deploy-race case self-heals.
 *
 * If both attempts fail the error propagates and our MapErrorBoundary
 * surfaces a recover-with-cache-clear UI.
 */

import { lazy, type ComponentType } from "react";

const RETRY_DELAY_MS = 500;

function isChunkError(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    if (e.name === "ChunkLoadError") return true;
    return (
        /Loading chunk \d+ failed/i.test(e.message) ||
        /Failed to fetch dynamically imported module/i.test(e.message) ||
        /Importing a module script failed/i.test(e.message)
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
    factory: () => Promise<{ default: T }>,
) {
    return lazy<T>(async () => {
        try {
            return await factory();
        } catch (e) {
            if (!isChunkError(e)) throw e;
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            return await factory();
        }
    });
}

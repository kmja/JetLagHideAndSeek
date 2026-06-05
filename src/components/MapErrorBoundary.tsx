import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Visible error boundary for the lazy-loaded map.
 *
 * Why this exists: the map ships as a separate ~880 KB chunk
 * (`Map-XXXXX.js` + `maplibre-gl-XXXXX.js`) lazy-loaded behind a
 * React.Suspense. Every deploy rotates those chunk hashes. If a
 * stale service worker keeps a previous deploy's index.html in
 * the precache (referencing the OLD chunk hashes), the lazy
 * import 404s when the new deploy has already overwritten the
 * old assets. Suspense alone has no opinion about errors —
 * without this boundary the result is a blank map area with no
 * recovery path. The user has to hard-refresh and isn't told
 * why.
 *
 * Catches the chunk-load failure, surfaces a "the map couldn't
 * load" card with a Reload button (which unregisters any active
 * service worker before reloading so the fresh page hits the
 * network, not a stale cache). After the reload the user lands
 * on the new deploy's index.html and the map loads correctly.
 *
 * Doesn't catch in-map runtime errors that fire AFTER the
 * component has mounted — those would still bubble up unhandled.
 * That's intentional: we want chunk-load failures to be
 * recoverable from the UI, but a true rendering bug should crash
 * loud so it's reported.
 */
interface State {
    error: Error | null;
}

export class MapErrorBoundary extends Component<
    { children: ReactNode },
    State
> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        // Only catch the kinds of errors that look like a chunk-
        // load failure. A real runtime bug in the map should
        // still bubble.
        const looksLikeChunkError =
            error.name === "ChunkLoadError" ||
            /Loading chunk \d+ failed/i.test(error.message) ||
            /Failed to fetch dynamically imported module/i.test(error.message) ||
            /Importing a module script failed/i.test(error.message);
        return looksLikeChunkError ? { error } : { error: null };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Surface to the console so the cause is visible in
        // dev / when the user reports the issue.
        console.warn("Map chunk failed to load:", error, info);
    }

    private handleReload = async () => {
        // Best-effort: unregister the SW and clear its caches so
        // a hard reload actually hits the network and pulls the
        // fresh index.html. Without this the same stale precache
        // would just serve the same dead chunk reference again.
        try {
            if ("serviceWorker" in navigator) {
                const regs =
                    await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map((r) => r.unregister()));
            }
            if ("caches" in window) {
                const keys = await caches.keys();
                await Promise.all(keys.map((k) => caches.delete(k)));
            }
        } catch {
            /* ignore — we'll reload anyway */
        }
        window.location.reload();
    };

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="absolute inset-0 flex items-center justify-center z-[1040] bg-background/95">
                <div className="max-w-sm w-[90%] rounded-md border-2 border-border bg-card shadow-xl p-5 space-y-3">
                    <div className="text-sm font-poppins font-black uppercase tracking-[0.14em] text-primary">
                        Map couldn't load
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug">
                        The map chunk failed to download. This usually
                        means a stale cached copy of the app is pointing
                        at an asset that the latest deploy has already
                        replaced. Reloading clears the cache and pulls
                        the fresh version.
                    </p>
                    <button
                        type="button"
                        onClick={this.handleReload}
                        className="w-full h-9 rounded-md bg-primary text-primary-foreground font-poppins font-bold text-xs uppercase tracking-wider hover:bg-primary/90 transition-colors"
                    >
                        Reload
                    </button>
                </div>
            </div>
        );
    }
}

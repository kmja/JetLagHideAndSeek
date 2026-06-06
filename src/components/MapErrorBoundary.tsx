import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Visible error boundary around the map subtree.
 *
 * Catches EVERY error the map throws (render-time, lazy chunk
 * load, MapLibre WebGL init, style-parse, etc.) and shows a
 * 'Map couldn't load' card with the message + a Reload button.
 * Without this boundary those errors bubble up to the root and
 * the whole page blanks with no recovery path — which is the
 * worst possible failure mode for the headline feature.
 *
 * The Reload button does a hard wipe: unregisters any active
 * service worker AND deletes every Cache Storage bucket before
 * reloading the page. That handles the historically-common
 * 'stale SW serves an index.html referencing chunk hashes that
 * the latest deploy already overwrote' case, but it's correct
 * for the other failure modes too — there's never a downside to
 * starting fresh when the map didn't render.
 *
 * The error message is exposed in the card so the user (or
 * we) can see what actually broke instead of staring at a
 * cosmetic 'something went wrong'.
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
        // Catch everything. A silent map area is the worst
        // possible failure for this feature; loudly explaining
        // what went wrong is strictly better than the previous
        // behaviour of 'render nothing and hope the user
        // refreshes'.
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Surface to the console so the cause is visible in dev
        // and when the user reports the issue (it'll show up in
        // their browser DevTools too).
        console.error("Map subtree crashed:", error, info);
    }

    private handleReload = async () => {
        // Best-effort SW + Cache Storage wipe so the reload
        // actually hits the network, not a stale precache that
        // would just serve the same dead asset reference.
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
        const err = this.state.error;
        if (!err) return this.props.children;
        // ChunkLoadError gets a friendlier message; everything
        // else surfaces the raw error message so a future bug
        // doesn't hide.
        const looksLikeChunkError =
            err.name === "ChunkLoadError" ||
            /Loading chunk \d+ failed/i.test(err.message) ||
            /Failed to fetch dynamically imported module/i.test(err.message) ||
            /Importing a module script failed/i.test(err.message);
        const blurb = looksLikeChunkError
            ? "A cached part of the app is pointing at an asset that the latest deploy already replaced. Reloading clears the cache and pulls the fresh version."
            : "Something went wrong while rendering the map. Reloading usually fixes it.";
        return (
            <div className="absolute inset-0 flex items-center justify-center z-[1040] bg-background/95">
                <div className="max-w-sm w-[90%] rounded-md border-2 border-border bg-card shadow-xl p-5 space-y-3">
                    <div className="text-sm font-poppins font-black uppercase tracking-[0.14em] text-primary">
                        Map couldn't load
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug">
                        {blurb}
                    </p>
                    {!looksLikeChunkError && (
                        <pre className="text-[10px] text-muted-foreground/80 leading-snug bg-secondary/30 rounded-sm p-2 overflow-auto max-h-24 whitespace-pre-wrap break-all">
                            {err.name}: {err.message}
                        </pre>
                    )}
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

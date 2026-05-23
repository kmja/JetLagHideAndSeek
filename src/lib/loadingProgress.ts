import { atom } from "nanostores";

/**
 * Cross-cutting loading-state atom. Used by the boundary-loading
 * pipeline (Overpass fetch → JSON parse → osmtogeojson → union →
 * simplify → render) to surface what's actually happening.
 *
 * The default `null` means "not currently loading anything"; a
 * non-null value means the LoadingOverlay should be visible.
 *
 * Why an atom and not just a toast? The boundary load for a country
 * runs through several phases — only the network phase has byte
 * progress, the parse phases need a different message — and packaging
 * all of that into a single mutable progress card is much clearer
 * than stacked toasts that each say "Loading map data...".
 */
export interface LoadingProgress {
    /** Short banner-style title. Stays the same across phases. */
    title: string;
    /** Optional sub-text describing the current phase. */
    phase: string;
    /** Optional bytes-downloaded counter (set during the network phase). */
    bytesDownloaded: number;
    /** Optional total bytes if Content-Length was honoured. */
    totalBytes: number | null;
    /** Unix ms — used to render elapsed-time + ETA. */
    startedAt: number;
}

export const loadingProgress = atom<LoadingProgress | null>(null);

/**
 * Open a new progress card. Subsequent `setPhase` / `setBytes`
 * calls update the same card without flicker.
 */
export function startLoading(title: string, phase: string): void {
    loadingProgress.set({
        title,
        phase,
        bytesDownloaded: 0,
        totalBytes: null,
        startedAt: Date.now(),
    });
}

export function setPhase(phase: string): void {
    const curr = loadingProgress.get();
    if (!curr) return;
    loadingProgress.set({ ...curr, phase });
}

/**
 * Per-piece loading state. The `determineMapBoundaries` pipeline
 * fans out multiple parallel fetches (primary + N adjacent areas);
 * each one is a piece with its own user-visible label
 * (e.g. "Stockholm Municipality", "Solna kommun") and its own
 * download state. The overlay shows one row per piece so the user
 * can see "things are happening" — even while a slow piece is
 * still server-computing, faster pieces tick visibly.
 *
 * The atom holds an array (not a Map) so the overlay can render
 * pieces in a stable order — primary first, then adjacents in the
 * order they were registered.
 */
export type LoadingPieceState =
    | "waiting"
    | "streaming"
    | "done"
    | "failed";

export interface LoadingPiece {
    /** Stable identifier (we use the request URL). */
    id: string;
    /** User-visible label, e.g. "Stockholm Municipality". */
    label: string;
    downloaded: number;
    total: number | null;
    state: LoadingPieceState;
}

export const loadingPieces = atom<LoadingPiece[]>([]);

function recomputeAndPublish(): void {
    const curr = loadingProgress.get();
    if (!curr) return;
    let downloaded = 0;
    let total: number | null = 0;
    let anyTotalUnknown = false;
    for (const piece of loadingPieces.get()) {
        downloaded += piece.downloaded;
        if (piece.total === null) anyTotalUnknown = true;
        else if (total !== null) total += piece.total;
    }
    if (anyTotalUnknown) total = null;
    if (
        curr.bytesDownloaded === downloaded &&
        curr.totalBytes === total
    ) {
        return;
    }
    loadingProgress.set({
        ...curr,
        bytesDownloaded: downloaded,
        totalBytes: total,
    });
}

/**
 * Register or update a piece. If a piece with `id` already exists,
 * its label and bytes are updated; otherwise it's appended.
 */
export function setBytesForUrl(
    url: string,
    downloaded: number,
    total: number | null,
    label?: string,
): void {
    if (!loadingProgress.get()) return;
    const pieces = loadingPieces.get();
    const idx = pieces.findIndex((p) => p.id === url);
    if (idx >= 0) {
        const prev = pieces[idx];
        // Don't downgrade a 'done' or 'failed' piece back to streaming.
        const state: LoadingPieceState =
            prev.state === "done" || prev.state === "failed"
                ? prev.state
                : "streaming";
        const next = [...pieces];
        next[idx] = {
            ...prev,
            downloaded,
            total,
            state,
            ...(label ? { label } : null),
        };
        loadingPieces.set(next);
    } else {
        loadingPieces.set([
            ...pieces,
            {
                id: url,
                label: label ?? url,
                downloaded,
                total,
                state: "streaming",
            },
        ]);
    }
    recomputeAndPublish();
}

/** Register a piece in the waiting state — used so the row
 *  appears immediately when the fetch is queued, before any
 *  bytes arrive. */
export function registerPiece(url: string, label: string): void {
    if (!loadingProgress.get()) return;
    const pieces = loadingPieces.get();
    const idx = pieces.findIndex((p) => p.id === url);
    if (idx >= 0) return; // already registered
    loadingPieces.set([
        ...pieces,
        {
            id: url,
            label,
            downloaded: 0,
            total: null,
            state: "waiting",
        },
    ]);
}

/** Mark a piece as fully downloaded. Snaps its `downloaded` to
 *  its `total` (or itself if total wasn't known) so the row
 *  reads "1.2 MB" cleanly. */
export function markPieceDone(url: string): void {
    const pieces = loadingPieces.get();
    const idx = pieces.findIndex((p) => p.id === url);
    if (idx < 0) return;
    const prev = pieces[idx];
    const final = prev.total ?? prev.downloaded;
    const next = [...pieces];
    next[idx] = {
        ...prev,
        downloaded: final,
        total: final > 0 ? final : prev.total,
        state: "done",
    };
    loadingPieces.set(next);
    recomputeAndPublish();
}

/** Mark a piece as failed — keeps it in the list so the user
 *  sees that one of the parallel fetches errored, while the
 *  rest can still finish. */
export function markPieceFailed(url: string): void {
    const pieces = loadingPieces.get();
    const idx = pieces.findIndex((p) => p.id === url);
    if (idx < 0) return;
    const next = [...pieces];
    next[idx] = { ...next[idx], state: "failed" };
    loadingPieces.set(next);
    recomputeAndPublish();
}

/** Backwards-compat shim — single-fetch callers still work. */
export function setBytes(downloaded: number, total: number | null): void {
    setBytesForUrl("__legacy_single__", downloaded, total);
}

export function finishLoading(): void {
    loadingProgress.set(null);
    loadingPieces.set([]);
}

/**
 * Format bytes as a friendly human-readable string. Sticks to a
 * decimal base since that's what most users associate with download
 * sizes ("12 MB" vs "11.4 MiB").
 */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Estimate remaining time from a download in progress. Returns null
 * when there's no total or the rate is too unstable to be meaningful.
 */
export function estimateEtaMs(p: LoadingProgress): number | null {
    if (p.totalBytes === null) return null;
    const elapsed = Date.now() - p.startedAt;
    if (elapsed < 500) return null; // too noisy
    if (p.bytesDownloaded <= 0) return null;
    const rate = p.bytesDownloaded / elapsed; // bytes / ms
    const remainingBytes = p.totalBytes - p.bytesDownloaded;
    if (remainingBytes <= 0) return 0;
    return Math.round(remainingBytes / rate);
}

export function formatDurationMs(ms: number): string {
    if (ms < 1000) return "<1s";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m ${rs}s`;
}

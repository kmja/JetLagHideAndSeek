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
 * Per-URL byte progress, aggregated into the overlay. The
 * `determineMapBoundaries` pipeline fans out multiple parallel
 * fetches (primary + N adjacent areas); each one calls
 * `setBytesForUrl(url, downloaded, total)` independently, and the
 * overlay shows the SUM across all in-flight URLs. Previously only
 * the first piece reported progress, so a slow first piece left
 * the counter stuck on 0 even while the others were downloading
 * happily.
 *
 * Tracked in a module-level map so the same URL re-arriving
 * (cancelled fetch + retry, or two concurrent calls hitting the
 * same URL) doesn't double-count — we replace the per-URL entry
 * each time and recompute the sum.
 */
const perUrlBytes = new Map<
    string,
    { downloaded: number; total: number | null }
>();

function recomputeAndPublish(): void {
    const curr = loadingProgress.get();
    if (!curr) return;
    let downloaded = 0;
    let total: number | null = 0;
    let anyTotalUnknown = false;
    for (const entry of perUrlBytes.values()) {
        downloaded += entry.downloaded;
        if (entry.total === null) anyTotalUnknown = true;
        else if (total !== null) total += entry.total;
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

export function setBytesForUrl(
    url: string,
    downloaded: number,
    total: number | null,
): void {
    if (!loadingProgress.get()) return;
    perUrlBytes.set(url, { downloaded, total });
    recomputeAndPublish();
}

/** Backwards-compat shim — single-fetch callers still work. */
export function setBytes(downloaded: number, total: number | null): void {
    setBytesForUrl("__legacy_single__", downloaded, total);
}

export function finishLoading(): void {
    loadingProgress.set(null);
    perUrlBytes.clear();
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

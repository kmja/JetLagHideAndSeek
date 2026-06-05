/**
 * Journey-time provider abstraction.
 *
 * The seeker app wants to display arrival times at transit stations:
 * "if the hider started moving from coordinate X at time T, when's
 * the earliest they could be standing at this station?" The actual
 * journey planning is provider-specific (Sweden's ResRobot, Norway's
 * Entur, Finland's Digitransit, etc.), so we publish a thin generic
 * interface and let each region register its own adapter.
 *
 * Concrete adapters live under `./providers/`; the registry in
 * `./registry.ts` picks one based on the play area's country (or
 * falls back to no-provider, in which case the UI hides the
 * Travel Times toggle).
 */

export interface JourneyAnchor {
    /** Where the journey starts. */
    lat: number;
    lng: number;
    /** Unix ms — the journey's departure timestamp. Usually the
     *  timestamp the seeker's last question was answered (the
     *  hider's last-known location). */
    departAt: number;
}

export interface JourneyStop {
    /** Stable per-provider identifier, opaque to callers. Used by
     *  the cache layer so refetches don't depend on coord rounding. */
    id: string;
    name?: string;
    lat: number;
    lng: number;
}

export interface JourneyResult {
    /** Stop identifier the result is for; mirrors the request. */
    stopId: string;
    /** Earliest arrival as Unix ms, or null if no journey was found
     *  within the provider's lookup window. */
    arrivalAt: number | null;
}

export interface JourneyProvider {
    /** Short identifier for logging / cache-key namespacing.
     *  e.g. "resrobot" / "entur" / "digitransit". */
    id: string;

    /** Human-readable name shown in the settings UI. */
    displayName: string;

    /** Hostname / docs link for the user to find / sign up for the
     *  API key the adapter expects. Surface in settings. */
    apiKeyUrl?: string;

    /** True if the provider can be used right now — typically
     *  "is the API key set". The UI uses this to grey out the
     *  Travel Times toggle. */
    isAvailable(): boolean;

    /**
     * Compute arrival times for every passed stop, given a single
     * departure anchor. Implementations are free to batch under the
     * hood (some providers expose many-to-one endpoints, most
     * don't); the caller should not assume any particular cost
     * shape but should treat this as potentially slow.
     *
     * Returns one result per requested stop, in the same order.
     * Stops the provider couldn't reach surface as
     * `{ arrivalAt: null }` rather than throwing — the UI just
     * shows them without a time label.
     */
    fetchArrivals(
        anchor: JourneyAnchor,
        stops: JourneyStop[],
        signal?: AbortSignal,
    ): Promise<JourneyResult[]>;
}

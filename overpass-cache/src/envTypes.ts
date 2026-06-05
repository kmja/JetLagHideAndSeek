/**
 * Shared Worker environment bindings.
 *
 * Split out of `index.ts` so the journey-arrival proxy in
 * `journey.ts` can import the same definition without creating a
 * circular import.
 */
export interface Env {
    /** R2 bucket holding both the Overpass query cache and the
     *  journey-arrival cache. Two key namespaces: `overpass/<hash>`
     *  and `journey/<hash>`. */
    CACHE: R2Bucket;
    /** Comma-separated allow-list of Origins permitted for CORS.
     *  Wildcards (`*`) become per-segment globs — see
     *  `originMatches` in index.ts. */
    ALLOWED_ORIGINS: string;
    /** Days after which an Overpass cache entry is considered
     *  stale and a refresh fetch is kicked off. */
    CACHE_TTL_DAYS: string;
    /** How many cities the weekly cron pre-warms per run. */
    PREWARM_BATCH_SIZE: string;
    /** Bearer token guarding `/admin/*` endpoints. Configure via
     *  `wrangler secret put ADMIN_SECRET` — do NOT commit. */
    ADMIN_SECRET?: string;
    /** Trafiklab ResRobot 2.1 access key, used by the
     *  /api/journey/arrivals proxy. Configure via
     *  `wrangler secret put TRAFIKLAB_API_KEY`. Optional — if
     *  unset, the journey endpoint returns 503 and the seeker
     *  app silently keeps the Travel Times overlay empty. */
    TRAFIKLAB_API_KEY?: string;
}

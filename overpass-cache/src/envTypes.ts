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
    /** R2 bucket holding the PMTiles vector basemap file(s) the
     *  seeker app reads via /tiles/*. Single key today
     *  (`basemap.pmtiles`); future regional shards will live under
     *  `regional/<iso3166>.pmtiles`. */
    TILES: R2Bucket;
    /** Comma-separated allow-list of Origins permitted for CORS.
     *  Wildcards (`*`) become per-segment globs — see
     *  `originMatches` in index.ts. */
    ALLOWED_ORIGINS: string;
    /** Days after which an Overpass cache entry is considered
     *  stale and a refresh fetch is kicked off. */
    CACHE_TTL_DAYS: string;
    /** How many cities the weekly cron pre-warms per run. */
    PREWARM_BATCH_SIZE: string;
    /** Feature flag for the global country-shard reference prewarm
     *  (Phase 5). When unset or not "true", the cron skips the
     *  country-references pass entirely — the existing per-city
     *  prewarm keeps running. Flip to "true" in the dashboard /
     *  wrangler.toml to start warming the 214 country shards. See
     *  overpass-cache/scripts/global-prewarm.md. */
    COUNTRY_REFS_PREWARM_ENABLED?: string;
    /** Feature flag for the per-city transit-route prewarm (Phase 6 —
     *  subway / bus / ferry overlays). Opt-OUT: enabled unless set to
     *  the exact string "false". Unlike HSR (an inter-city network
     *  warmed per-country), local transit routes are keyed on the
     *  city's bbox, so they're warmed per-city with the byte-identical
     *  query the client issues. Set to "false" in the dashboard /
     *  wrangler.toml to disable if the heavy bus responses strain the
     *  worker. See overpass-cache/scripts/laptop-prewarm.mjs for the
     *  offline equivalent that covers mega-metros over the size cap. */
    TRANSIT_PREWARM_ENABLED?: string;
    /** Bearer token guarding `/admin/*` endpoints. Configure via
     *  `wrangler secret put ADMIN_SECRET` — do NOT commit. */
    ADMIN_SECRET?: string;
    /** Trafiklab ResRobot 2.1 access key, used by the
     *  /api/journey/arrivals proxy. Configure via
     *  `wrangler secret put TRAFIKLAB_API_KEY`. Optional — if
     *  unset, the journey endpoint returns 503 and the seeker
     *  app silently keeps the Travel Times overlay empty. */
    TRAFIKLAB_API_KEY?: string;
    /** Digitransit (Finland) subscription key, used by the
     *  `/api/travel/plan` Digitransit adapter. Configure via
     *  `wrangler secret put DIGITRANSIT_API_KEY`. Optional — if
     *  unset, the adapter defers and the dispatcher falls through
     *  to the walking backstop. */
    DIGITRANSIT_API_KEY?: string;
    /** TfL (London) Unified API app key. Configure via
     *  `wrangler secret put TFL_API_KEY`. Optional — TfL accepts
     *  unauthenticated calls at a lower rate limit, so the
     *  adapter works without a key, and just runs faster with one. */
    TFL_API_KEY?: string;
    /** navitia.io API key for the broad-European `/api/travel/plan`
     *  fallback adapter (covers France/Paris, Benelux, Iberia, Italy,
     *  …). Configure via `wrangler secret put NAVITIA_API_KEY`. Free
     *  signup at https://navitia.io/. Optional — without it the
     *  adapter defers and those regions fall through to walking. */
    NAVITIA_API_KEY?: string;
    /** Transport for NSW (Sydney/Australia) Open Data Trip Planner
     *  key, sent as `Authorization: apikey <KEY>`. Configure via
     *  `wrangler secret put TFNSW_API_KEY`. Free signup at the TfNSW
     *  Open Data Hub. Optional — without it NSW origins fall through
     *  to walking. (Norway/Switzerland/Germany/Denmark are keyless.) */
    TFNSW_API_KEY?: string;
    /** TMB (Barcelona) OpenTripPlanner keys — free, no billing, from
     *  developer.tmb.cat. BOTH required (passed as `app_id`/`app_key`).
     *  Optional — Barcelona origins defer to walking without them. */
    TMB_APP_ID?: string;
    TMB_APP_KEY?: string;
    /** NS (Netherlands) Reisinformatie key — free, no billing, from
     *  apiportal.ns.nl. Rail-centric. Optional. */
    NS_API_KEY?: string;
    /** ODsay (South Korea) key — free tier 1,000/day, no billing, from
     *  lab.odsay.com. Optional. */
    ODSAY_API_KEY?: string;
    /** Full plan-endpoint URL of an operator-run, SELF-HOSTED MOTIS
     *  instance, e.g. `https://motis.example.com/api/v1/plan`. When set,
     *  it's the license-clean universal fallback (ordered ahead of the
     *  public Transitous instance). MOTIS is FOSS — self-host it over
     *  the Mobility Database GTFS to avoid Transitous's non-commercial
     *  restriction. Optional. */
    MOTIS_SELF_HOSTED_URL?: string;
    // The public `transitous` fallback is free + KEYLESS (MOTIS over the
    // Mobility Database) — no secret — but is flagged non-commercial
    // (see adapters/transitous.ts). Paid providers (Google Directions /
    // HERE) are deliberately NOT used — they require billing.
}

/**
 * Transitous — free, community-run, near-universal transit router.
 *
 * Transitous (https://transitous.org) is a free, donation-funded public
 * transport routing service built on the MOTIS engine, routing over the
 * GTFS feeds catalogued in the **Mobility Database**. It is **keyless**
 * and has **no billing** — no credit card, no per-request charge — which
 * is exactly why it replaces the paid Google/HERE universal providers
 * here. Coverage is global-ish and growing (heavy in Europe, expanding
 * across North America/Asia as feeds are added to the catalog).
 *
 * This is effectively the "self-hosted GTFS raptor over the Mobility
 * Database" idea (the deferred M5), except the community already hosts
 * it for free — so we just call it. As the universal free fallback it
 * sits after the free regional adapters + navitia, before walking.
 *
 * ⚠️ TODO / LICENSE CHECK (flagged by Kalle): the Transitous site states
 * it is "not intended for commercial or for-profit purposes; contact us
 * if unsure — decided case-by-case." This app is currently a free hobby
 * project, so it's plausibly fine, but BEFORE any commercial/monetised
 * use we must confirm with the Transitous maintainers (contact via
 * transitous.org). If they decline, drop this adapter — every other
 * provider here is unambiguously free-for-any-use, and the regional
 * adapters cover most populated areas anyway. Keeping it for now.
 *
 * API: MOTIS v2 `GET /api/v1/plan` (OTP-shaped). Be a polite citizen
 * with the shared free instance — the worker's edge+R2 cache already
 * dedupes by (origin, dest, 5-min bucket), so repeated lookups don't
 * re-hit it.
 *
 * Not live-testable from here (sandbox blocks egress); request shape
 * follows the MOTIS API and the response PARSER is fixture-tested. A
 * wrong request degrades to the walking estimate.
 */

import { legGeometryPoints } from "../polyline";
import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const TRANSITOUS_URL = "https://api.transitous.org/api/v1/plan";
const UPSTREAM_TIMEOUT_MS = 12_000;

/**
 * Access/egress walking budget (seconds) MOTIS may use to reach transit
 * from the origin and to leave transit at the destination. MOTIS defaults
 * this to ~15 min; that stranded trips where the seeker's GPS OR the
 * tapped station was a longer walk from the nearest stop — MOTIS then
 * found NO transit itinerary and the plan fell to the straight-line
 * walking backstop even though the stop clearly has departures (the
 * "300-minute walk with a live departures board" bug). 30 min each way
 * lets MOTIS connect a farther origin/destination to the network.
 */
const MAX_ACCESS_EGRESS_SECS = 1_800;

/** Universal — Transitous routes wherever the Mobility Database has a
 *  feed. Outside its coverage it simply returns no itinerary and the
 *  dispatcher falls through to walking. */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaMotis(TRANSITOUS_URL, req, departAt, signal);
}

/**
 * Generic MOTIS v2 `/api/v1/plan` fetch against any MOTIS instance —
 * the public Transitous one OR a self-hosted box (see
 * `motisSelfHosted.ts`). `planUrl` is the full plan endpoint. Both use
 * the identical request + `parseMotisPlan` response shape.
 */
export async function planViaMotis(
    planUrl: string,
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(planUrl);
    // MOTIS takes `fromPlace` / `toPlace` as "lat,lon".
    url.searchParams.set("fromPlace", `${req.origin.lat},${req.origin.lng}`);
    url.searchParams.set(
        "toPlace",
        `${req.destination.lat},${req.destination.lng}`,
    );
    url.searchParams.set("time", new Date(departAt).toISOString());
    url.searchParams.set("arriveBy", "false");
    // Let MOTIS walk further to reach/leave the transit network than its
    // ~15-min default, so an origin/destination that isn't right next to a
    // stop still yields a transit itinerary instead of falling through to
    // the walking backstop. (Unknown params are ignored by MOTIS, so this
    // is safe if an instance predates these fields.)
    url.searchParams.set("maxPreTransitTime", String(MAX_ACCESS_EGRESS_SECS));
    url.searchParams.set(
        "maxPostTransitTime",
        String(MAX_ACCESS_EGRESS_SECS),
    );
    // Tell MOTIS which transit vehicle types the player is allowed to use,
    // so it returns COMPLIANT itineraries directly (v833). Without this,
    // MOTIS ranks e.g. a bus-inclusive trip first in a game where bus isn't
    // allowed; every returned itinerary then rides a banned mode, so the
    // client-side filter rejects them ALL and the dispatcher falls through
    // to the walking backstop — the reported "walking-only in NYC even
    // though the departures board shows the Q" bug. Passing `transitModes`
    // makes MOTIS surface the subway/rail itinerary instead. Only set it
    // when the game restricts modes; an unknown param is ignored by older
    // MOTIS instances (safe — same behaviour as before).
    const motisModes = motisTransitModes(req.modes);
    if (motisModes) url.searchParams.set("transitModes", motisModes);

    // One-shot fetch helper (abort/timeout-safe). Returns the Response or
    // null on a network/abort error — a non-OK status still resolves so the
    // caller can decide whether to retry.
    const doFetch = async (u: string): Promise<Response | null> => {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
        try {
            return await fetch(u, {
                signal: ctrl.signal,
                headers: { Accept: "application/json" },
            });
        } catch (e) {
            console.warn("MOTIS fetch failed:", e);
            return null;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    };

    let resp = await doFetch(url.toString());
    // Defense-in-depth: if the modes-constrained request is REJECTED (most
    // likely a 400 from an invalid/stale `transitModes` enum value — the
    // class of bug that made every NYC trip fall to walking), retry ONCE
    // WITHOUT the constraint. `parseMotisPlan` already picks a mode-compliant
    // transit-bearing itinerary out of MOTIS's full ranked list (honouring
    // `req.modes`), so dropping the hint costs us nothing but ranking — and a
    // future stale enum can never again silently collapse the planner to a
    // walking estimate.
    if (resp && !resp.ok && motisModes) {
        console.warn(
            "MOTIS non-OK with transitModes:",
            resp.status,
            resp.statusText,
            "— retrying unconstrained",
        );
        url.searchParams.delete("transitModes");
        resp = await doFetch(url.toString());
    }
    if (!resp) return null;
    if (!resp.ok) {
        console.warn("MOTIS non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseMotisPlan(json, req.destination, req.modes);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface MotisPlace {
    name?: string;
    lat?: number;
    lon?: number;
}

/**
 * Normalise a MOTIS v2 `/api/v1/plan` response (`{ itineraries: [{
 * legs: [...] }] }`) into our `Journey`. MOTIS legs are OTP-shaped:
 * `mode`, ISO `startTime`/`endTime`, `from`/`to` places, `distance`,
 * `routeShortName`, `headsign`.
 *
 * MOTIS returns MULTIPLE ranked itineraries and frequently ranks a
 * WALK-ONLY "direct" option first (it can be the shortest by its own
 * metric). Naively taking `itineraries[0]` therefore surfaced a bogus
 * "walking only" plan even though transit itineraries followed — the
 * exact "planner shows walking but the departures board has transit"
 * bug. So we parse EVERY itinerary and pick the best:
 *   1. a mode-compliant itinerary that actually uses transit, else
 *   2. any mode-compliant itinerary (a genuine walk-only trip), else
 *   3. the first parseable itinerary (dispatcher still mode-filters it).
 * `allowedModes` (the request's transit allow-set) is honoured here so a
 * banned-mode "best" itinerary doesn't shadow an allowed transit one that
 * MOTIS ranked lower.
 */
export function parseMotisPlan(
    json: unknown,
    destFallback: TravelPlace,
    allowedModes?: TravelMode[],
): Journey | null {
    const itineraries = (json as { itineraries?: unknown[] }).itineraries;
    if (!Array.isArray(itineraries) || itineraries.length === 0) return null;

    const parsed: Journey[] = [];
    for (const raw of itineraries) {
        const j = parseItinerary(raw, destFallback);
        if (j) parsed.push(j);
    }
    if (parsed.length === 0) return null;

    const hasTransit = (j: Journey) => j.legs.some((l) => l.mode !== "walk");
    const modeOk = (j: Journey) => {
        if (!allowedModes || allowedModes.length === 0) return true;
        const allow = new Set<string>(allowedModes);
        return j.legs.every(
            (l) =>
                l.mode === "walk" ||
                l.mode === "transit" ||
                allow.has(l.mode),
        );
    };

    return (
        parsed.find((j) => modeOk(j) && hasTransit(j)) ??
        parsed.find((j) => modeOk(j)) ??
        parsed[0]
    );
}

/** Parse one MOTIS itinerary (`{ legs: [...] }`) into a Journey, or null
 *  if it has no usable legs / times. */
function parseItinerary(raw: unknown, destFallback: TravelPlace): Journey | null {
    const it = raw as { legs?: unknown[] };
    const rawLegs = it.legs;
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;

    const legs: JourneyLeg[] = [];
    for (const rawLeg of rawLegs) {
        const leg = parseLeg(rawLeg, destFallback);
        if (leg) legs.push(leg);
    }
    if (legs.length === 0) return null;

    const departAt = legs[0].departAt;
    const arriveAt = legs[legs.length - 1].arriveAt;
    if (!Number.isFinite(departAt) || !Number.isFinite(arriveAt)) return null;

    const transitLegs = legs.filter((l) => l.mode !== "walk").length;
    return {
        departAt,
        arriveAt,
        durationMin: Math.max(1, Math.round((arriveAt - departAt) / 60_000)),
        transfers: Math.max(0, transitLegs - 1),
        legs,
    };
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        mode?: string;
        startTime?: string;
        endTime?: string;
        distance?: number;
        from?: MotisPlace;
        to?: MotisPlace;
        routeShortName?: string;
        routeLongName?: string;
        headsign?: string;
        legGeometry?: unknown;
    };
    const departAt = parseISO(leg.startTime);
    const arriveAt = parseISO(leg.endTime);
    if (departAt == null || arriveAt == null) return null;

    const mode = classifyMode(leg.mode);
    const isWalk = mode === "walk";
    const out: JourneyLeg = {
        mode,
        from: place(leg.from),
        to: place(leg.to, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk) {
        const line = leg.routeShortName ?? leg.routeLongName;
        if (line) out.line = line;
        if (leg.headsign) out.direction = leg.headsign;
    }
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    const shape = legGeometryPoints(leg.legGeometry);
    if (shape) out.geometry = shape;
    return out;
}

function place(p: MotisPlace | undefined, fallback?: TravelPlace): TravelPlace {
    return {
        lat: typeof p?.lat === "number" ? p.lat : (fallback?.lat ?? 0),
        lng: typeof p?.lon === "number" ? p.lon : (fallback?.lng ?? 0),
        name: p?.name ?? fallback?.name,
    };
}

/** Our allowed transit modes → the MOTIS `transitModes` param value (the
 *  inverse of `classifyMode`). Returns null when no restriction applies
 *  (empty/undefined `modes` = "any mode", so we don't constrain MOTIS).
 *  `WALK` is always included so MOTIS can still use access/egress walking
 *  legs; the vehicle types gate which transit it may board. */
const MOTIS_MODE_MAP: Record<TravelMode, string[]> = {
    bus: ["BUS", "COACH"],
    tram: ["TRAM"],
    // ONLY `SUBWAY` — the stable enum. `METRO` was RENAMED to `SUBURBAN` in
    // MOTIS 2.5.0 (the version the public Transitous instance runs), so it is
    // no longer a valid `Mode`. Sending it put an INVALID enum value into the
    // known `transitModes` parameter, which makes MOTIS reject the ENTIRE
    // /api/v1/plan request with a 400 → `planViaMotis` returned null → the
    // dispatcher fell through to the walking backstop. That was the "walking
    // estimate in NYC even though the subway departures board shows trains"
    // bug: a NYC no-bus game emitted `…,SUBWAY,METRO,…` and 400'd every trip.
    // (Suburban/S-Bahn rail — the thing MOTIS now calls SUBURBAN — is not the
    // subway anyway; it's covered by the `train` RAIL family below.)
    subway: ["SUBWAY"],
    train: [
        "RAIL",
        "REGIONAL_RAIL",
        "REGIONAL_FAST_RAIL",
        "LONG_DISTANCE",
        "HIGHSPEED_RAIL",
        "NIGHT_RAIL",
    ],
    ferry: ["FERRY"],
};

export function motisTransitModes(modes?: TravelMode[]): string | null {
    if (!modes || modes.length === 0) return null;
    const out = new Set<string>(["WALK"]);
    for (const m of modes) {
        for (const v of MOTIS_MODE_MAP[m] ?? []) out.add(v);
    }
    // WALK alone isn't a transit restriction — bail so MOTIS stays
    // unconstrained rather than being told "no transit at all".
    return out.size > 1 ? [...out].join(",") : null;
}

/** MOTIS/OTP `mode` → our mode. */
function classifyMode(mode?: string): "walk" | TravelMode | "transit" {
    switch ((mode ?? "").toUpperCase()) {
        case "WALK":
            return "walk";
        case "BUS":
        case "COACH":
        case "TROLLEYBUS":
            return "bus";
        case "TRAM":
        case "CABLE_CAR":
        case "FUNICULAR":
            return "tram";
        case "SUBWAY":
        case "METRO":
            return "subway";
        case "RAIL":
        case "REGIONAL_RAIL":
        case "REGIONAL_FAST_RAIL":
        case "COMMUTER_RAIL":
        // MOTIS 2.5.0 renamed `METRO` (suburban / S-Bahn class rail) to
        // `SUBURBAN`; classify it as train, matching the `train` RAIL family.
        case "SUBURBAN":
        case "LONG_DISTANCE":
        case "HIGHSPEED_RAIL":
        case "NIGHT_RAIL":
            return "train";
        case "FERRY":
            return "ferry";
        default:
            return "transit";
    }
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

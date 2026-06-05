/**
 * Provider registry. The seeker app currently only ships the
 * ResRobot (Sweden) adapter, but the architecture is set up so
 * adding Entur (Norway), Digitransit (Finland), opentransportdata
 * (Switzerland), etc. is just a new file under ./providers/ + a
 * line here.
 *
 * Per-country dispatch is intentionally deferred — the user
 * picks the provider implicitly by entering its API key in
 * settings. When zero providers have a key set, the Travel
 * Times toggle in MapDisplayControls is greyed out.
 */

import { createResRobotProvider } from "./resrobot";
import type { JourneyProvider } from "./types";

// One module-level instance per provider. The Trafiklab key is
// server-side now (held by the overpass-cache worker as a
// wrangler secret) so the constructor takes no client config.
const RESROBOT = createResRobotProvider();

const PROVIDERS: JourneyProvider[] = [RESROBOT];

/** Pick whichever provider currently has a usable API key. Returns
 *  null when none do. */
export function activeJourneyProvider(): JourneyProvider | null {
    for (const p of PROVIDERS) {
        if (p.isAvailable()) return p;
    }
    return null;
}

/** All registered providers, even the unavailable ones — for the
 *  settings UI that lists each one with its API-key field. */
export function allJourneyProviders(): JourneyProvider[] {
    return PROVIDERS;
}

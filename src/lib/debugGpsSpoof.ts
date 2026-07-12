import { atom } from "nanostores";

/**
 * Debug GPS spoofing (v353).
 *
 * Lets a developer drop their "current location" anywhere — specifically
 * at a random point inside the active play area — so play areas all over
 * the world can be tested without physically being there.
 *
 * Implementation: a single monkey-patch of `navigator.geolocation`. The
 * app reads GPS from ~10 call sites (Map, the location pickers, the
 * thermometer, the seeker-location broadcast, …); intercepting at the
 * platform API covers every one of them without touching each.
 *
 * `spoofedPosition` is deliberately a VOLATILE atom (not persisted): a
 * reload returns real GPS, so a forgotten spoof can't silently break
 * location forever. Re-spoofing is one click.
 */
export const spoofedPosition = atom<{ lat: number; lng: number } | null>(null);

/**
 * When true, the next tap on the seeker/hider map sets the spoof to that
 * exact point (constrained to the play area) instead of doing the map's
 * normal click behaviour. Lets a developer place their spoofed location
 * precisely rather than accepting a random point. Volatile; a tap (or
 * cancel) clears it.
 */
export const spoofPickMode = atom<boolean>(false);

/** Build a GeolocationPosition-shaped object our consumers can read. */
function makePosition(lat: number, lng: number): GeolocationPosition {
    const coords: GeolocationCoordinates = {
        latitude: lat,
        longitude: lng,
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        // toJSON exists in newer specs; harmless to include.
        toJSON() {
            return this;
        },
    } as GeolocationCoordinates;
    return {
        coords,
        timestamp: Date.now(),
        toJSON() {
            return this;
        },
    } as GeolocationPosition;
}

let installed = false;

/**
 * Install the geolocation monkey-patch. Idempotent. MUST run before any
 * component mounts (so a watch started at mount is spoof-aware) — call it
 * at module load from the app entry, not in a useEffect.
 */
export function installGpsSpoof(): void {
    if (installed) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const geo = navigator.geolocation;
    const realGetCurrent = geo.getCurrentPosition.bind(geo);
    const realWatch = geo.watchPosition.bind(geo);
    const realClear = geo.clearWatch.bind(geo);

    // Spoof-managed watches keyed by a NEGATIVE id so clearWatch can tell
    // them apart from real (positive) watch ids.
    const spoofWatches = new Map<
        number,
        { realId: number | null; unsub: () => void }
    >();
    let nextSpoofId = -1;

    geo.getCurrentPosition = (success, error, options) => {
        const spoof = spoofedPosition.get();
        if (spoof) {
            // Async to match the real API's contract.
            setTimeout(() => success(makePosition(spoof.lat, spoof.lng)), 0);
            return;
        }
        return realGetCurrent(success, error ?? undefined, options);
    };

    geo.watchPosition = (success, error, options) => {
        const id = nextSpoofId--;
        let lastReal: GeolocationPosition | null = null;
        let realId: number | null = null;
        // Keep a real underlying watch running so that, the moment the
        // spoof is cleared, live GPS resumes — even for watches that were
        // started before spoofing began (e.g. the main map's blue dot).
        try {
            realId = realWatch(
                (pos) => {
                    lastReal = pos;
                    // Pass real positions through only while not spoofing.
                    if (!spoofedPosition.get()) success(pos);
                },
                error ?? undefined,
                options,
            );
        } catch {
            /* real geolocation unavailable — spoof still works */
        }
        // nanostores `subscribe` fires synchronously with the current
        // value, so this also delivers an already-set spoof immediately
        // on watch start, and re-delivers whenever it changes. On clear
        // (spoof → null) we re-emit the last real fix for a snappy revert.
        const unsub = spoofedPosition.subscribe((spoof) => {
            if (spoof) {
                success(makePosition(spoof.lat, spoof.lng));
            } else if (lastReal) {
                success(lastReal);
            }
        });
        spoofWatches.set(id, { realId, unsub });
        return id;
    };

    geo.clearWatch = (id) => {
        const entry = spoofWatches.get(id);
        if (entry) {
            if (entry.realId !== null) realClear(entry.realId);
            entry.unsub();
            spoofWatches.delete(id);
            return;
        }
        return realClear(id);
    };

    installed = true;
}

// `spoofRandomInPlayArea` (the only turf consumer) moved to
// `debugSpoofArea.ts` so this eagerly-imported module (App.tsx calls
// `installGpsSpoof` at load) no longer drags @turf/turf + d3 into the
// first-paint bundle. See that file's header for the why.

/** Stop spoofing — real GPS resumes. */
export function clearGpsSpoof(): void {
    spoofedPosition.set(null);
}

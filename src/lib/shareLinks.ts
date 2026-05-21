import type { Question } from "@/maps/schema";

/**
 * Stateless share-link encoding for the hider/seeker handoff.
 *
 * The flow:
 *   1. Seeker confirms a new question -> we generate a HIDER URL containing
 *      the full question payload. Seeker shares this via the OS share sheet.
 *   2. Hider opens the URL -> /h route reads the payload, renders read-only
 *      question card + answer controls.
 *   3. Hider picks an answer -> we generate an ANSWER URL with just the
 *      question key + answer fields. Hider shares this back.
 *   4. Seeker taps the answer URL -> main app reads ?a= on load, finds the
 *      question by key, merges in the answer.
 *
 * No backend; the URL itself is the entire state transport.
 */

/** Get the origin to use for share links. Resolves at call time so deployments work. */
function getOrigin(): string {
    if (typeof window !== "undefined" && window.location?.origin) {
        return window.location.origin;
    }
    // SSR fallback. Should never actually be used since share calls happen
    // in client event handlers.
    return "https://jetlaghideandseek.karl-mj-andersson.workers.dev";
}

/**
 * Encode a question into a URL the hider can open in their browser.
 * Uses JSON + encodeURIComponent — no base64 to keep the URL inspectable
 * if anyone wants to debug.
 */
export function encodeQuestionForHider(question: Question): string {
    const payload = JSON.stringify(question);
    return `${getOrigin()}/h?q=${encodeURIComponent(payload)}`;
}

/** Decode a question from a URLSearchParams or URL string. Returns null on failure. */
export function decodeQuestionFromUrl(
    source: URLSearchParams | string,
): Question | null {
    let raw: string | null = null;
    if (typeof source === "string") {
        try {
            raw = new URL(source).searchParams.get("q");
        } catch {
            return null;
        }
    } else {
        raw = source.get("q");
    }
    if (!raw) return null;
    try {
        return JSON.parse(decodeURIComponent(raw)) as Question;
    } catch {
        return null;
    }
}

export interface SharedAnswerPayload {
    /** Stable question key — matches against the seeker's existing questions store. */
    key: number;
    /** Partial data merge applied to the matched question. */
    answer: Record<string, unknown>;
}

/**
 * Encode the hider's answer into a URL the seeker can tap to apply.
 * The answer is a partial merge of the question's data field; the seeker's
 * app patches their existing question rather than recreating it.
 */
export function encodeAnswerForSeeker(
    key: number,
    answer: Record<string, unknown>,
): string {
    const payload = JSON.stringify({ key, answer });
    return `${getOrigin()}/?a=${encodeURIComponent(payload)}`;
}

/** Decode an answer payload from the URL. Returns null on failure or malformed input. */
export function decodeAnswerFromUrl(
    source: URLSearchParams | string,
): SharedAnswerPayload | null {
    let raw: string | null = null;
    if (typeof source === "string") {
        try {
            raw = new URL(source).searchParams.get("a");
        } catch {
            return null;
        }
    } else {
        raw = source.get("a");
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (typeof parsed?.key !== "number") return null;
        if (typeof parsed?.answer !== "object" || parsed.answer === null) {
            return null;
        }
        return parsed as SharedAnswerPayload;
    } catch {
        return null;
    }
}

/* ──────────────────── Curse-cast payloads (hider → seeker) ──────────────────── */

export interface SharedCursePayload {
    /** Curse name as it appears on the card (e.g. "Curse of the Bridge Troll"). */
    name: string;
    /** Effect description. */
    description: string;
    /** Casting requirement, if any. */
    castingCost: string | null;
}

/**
 * Encode a curse the hider just cast into a URL the seeker can tap to
 * receive. Uses the same `?c=` query param style as `?a=` for answers,
 * so the seeker app can dispatch on which one is present.
 */
export function encodeCurseLink(curse: SharedCursePayload): string {
    const payload = JSON.stringify(curse);
    return `${getOrigin()}/?c=${encodeURIComponent(payload)}`;
}

/** Decode a curse payload from a URLSearchParams or URL string. */
export function decodeCurseFromUrl(
    source: URLSearchParams | string,
): SharedCursePayload | null {
    let raw: string | null = null;
    if (typeof source === "string") {
        try {
            raw = new URL(source).searchParams.get("c");
        } catch {
            return null;
        }
    } else {
        raw = source.get("c");
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (typeof parsed?.name !== "string") return null;
        if (typeof parsed?.description !== "string") return null;
        return parsed as SharedCursePayload;
    } catch {
        return null;
    }
}

/* ──────────────────── Found event (seeker → hider) ──────────────────── */

export interface SharedFoundPayload {
    /** Unix ms when the seeker declared the hider found. */
    foundAt: number;
}

/**
 * Encode a "found" event into a URL the hider can tap to lock their
 * round. Uses `?f=` so the seeker app can dispatch alongside `?a=` and
 * `?c=`. The hider's app sets `roundFoundAt` to the included timestamp,
 * which freezes the elapsed timer and time-bonus tally for scoring.
 */
export function encodeFoundLink(foundAt: number): string {
    const payload = JSON.stringify({ foundAt });
    return `${getOrigin()}/h?f=${encodeURIComponent(payload)}`;
}

/** Decode a found-event payload from a URLSearchParams or URL string. */
export function decodeFoundFromUrl(
    source: URLSearchParams | string,
): SharedFoundPayload | null {
    let raw: string | null = null;
    if (typeof source === "string") {
        try {
            raw = new URL(source).searchParams.get("f");
        } catch {
            return null;
        }
    } else {
        raw = source.get("f");
    }
    if (!raw) return null;
    try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (typeof parsed?.foundAt !== "number") return null;
        return parsed as SharedFoundPayload;
    } catch {
        return null;
    }
}

/**
 * Helper for share-with-fallback. Calls navigator.share when supported,
 * falls back to clipboard copy otherwise. Returns true if the user
 * completed the action (either share or copy), false if cancelled.
 *
 * Caller is responsible for any toast messages.
 */
export async function shareOrCopy(payload: {
    title: string;
    text: string;
    url: string;
}): Promise<{ method: "share" | "copy" | "cancelled" | "failed" }> {
    try {
        if (
            typeof navigator !== "undefined" &&
            typeof navigator.share === "function"
        ) {
            await navigator.share(payload);
            return { method: "share" };
        }
        if (typeof navigator?.clipboard?.writeText === "function") {
            await navigator.clipboard.writeText(payload.url);
            return { method: "copy" };
        }
        return { method: "failed" };
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            return { method: "cancelled" };
        }
        return { method: "failed" };
    }
}

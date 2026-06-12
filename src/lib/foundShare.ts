import { toast } from "react-toastify";

import { encodeFoundLink, shareOrCopy } from "@/lib/shareLinks";

/**
 * Hand the round-end link off to the OS share sheet (or copy it to
 * clipboard as a fallback). Used by both the HiderTimer's
 * "Mark hider found" button (in-game CTA) and the BottomNav's
 * FoundSummary "Share again" action (post-game).
 */
export async function shareFoundLink(foundAt: number): Promise<void> {
    const url = encodeFoundLink(foundAt);
    const result = await shareOrCopy({
        title: "Round ended",
        text: `I found the hider! Tap to end your timer: ${url}`,
        url,
    });
    if (result.method === "copy") {
        toast.success("Round-ended link copied", { autoClose: 1500 });
    } else if (result.method === "failed") {
        toast.error("Could not share the round-end link");
    }
}

/**
 * Manual fallback for the round-end link: writes the URL directly to
 * the clipboard. Surfaced as an outline button next to Share in the
 * FoundSummary card so the seeker has a guaranteed recovery path if
 * the OS share sheet keeps getting dismissed.
 */
export async function copyFoundLink(foundAt: number): Promise<void> {
    const url = encodeFoundLink(foundAt);
    try {
        await navigator.clipboard.writeText(url);
        toast.success("Round-ended link copied", { autoClose: 1500 });
    } catch {
        toast.error("Could not copy the round-end link");
    }
}

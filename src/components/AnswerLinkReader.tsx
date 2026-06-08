import { useEffect } from "react";
import { toast } from "react-toastify";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { questionModified, questions } from "@/lib/context";
import { notify } from "@/lib/notifications";
import { receivedCurses } from "@/lib/seekerInbound";
import {
    decodeAnswerFromUrl,
    decodeCurseFromUrl,
} from "@/lib/shareLinks";

/**
 * Handles inbound payloads delivered to the seeker via URL query params:
 *
 *   - `?a=…`  — the hider's answer to a previously-asked question. Merges
 *     into the matching `questions` entry, flips `drag:false` (commit),
 *     toasts confirmation.
 *
 *   - `?c=…`  — a curse the hider just cast on the seeker. Appended to
 *     `receivedCurses` (persistent), the seeker sees a clear notification
 *     with the curse name + rules text. Drops into discard on dismiss.
 *
 * Always strips the consumed param from the URL via `history.replaceState`
 * so a refresh doesn't re-apply the same payload. Renders nothing — drop
 * into the layout as a client:only island alongside Map / BottomNav.
 */
export function AnswerLinkReader() {
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        let consumed: "a" | "c" | null = null;

        // --- Curse first, since the param is more specific ---
        try {
            const cursePayload = decodeCurseFromUrl(params);
            if (cursePayload) {
                consumed = "c";
                receivedCurses.set([
                    ...receivedCurses.get(),
                    {
                        ...cursePayload,
                        receivedAt: Date.now(),
                        acknowledged: false,
                    },
                ]);
                toast.error(`${cursePayload.name} cast on you!`, {
                    autoClose: 5000,
                    toastId: `curse-${cursePayload.name}`,
                });
                notify({
                    title: "Curse received",
                    body: cursePayload.name,
                    tag: `curse-${cursePayload.name}`,
                });
            }
        } catch (e) {
            console.warn("AnswerLinkReader (curse path) failed:", e);
        }

        // --- Answer second ---
        if (!consumed) {
            try {
                const payload = decodeAnswerFromUrl(params);
                if (payload) {
                    consumed = "a";
                    const list = questions.get();
                    const target = list.find((q) => q.key === payload.key);
                    if (!target) {
                        toast.error(
                            "Got an answer link, but I don't have the matching question saved. Was it asked on a different device?",
                            {
                                autoClose: 5000,
                                toastId: "answer-link-no-match",
                            },
                        );
                    } else {
                        Object.assign(target.data, payload.answer, {
                            drag: false,
                        });
                        questionModified();
                        const catLabel =
                            CATEGORIES[target.id as CategoryId]?.label ??
                            "Question";
                        toast.success(`Answer received for ${catLabel}.`, {
                            autoClose: 3000,
                            toastId: `answer-link-${payload.key}`,
                        });
                    }
                }
            } catch (e) {
                console.warn("AnswerLinkReader (answer path) failed:", e);
            }
        }

        // --- URL cleanup ---
        try {
            const url = new URL(window.location.href);
            let changed = false;
            for (const key of ["a", "c"] as const) {
                if (url.searchParams.has(key)) {
                    url.searchParams.delete(key);
                    changed = true;
                }
            }
            if (changed) {
                window.history.replaceState(
                    {},
                    "",
                    url.pathname + url.search + url.hash,
                );
            }
        } catch {
            /* noop */
        }
    }, []);

    return null;
}

export default AnswerLinkReader;

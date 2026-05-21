import { useEffect } from "react";
import { toast } from "react-toastify";

import { questionModified, questions } from "@/lib/context";
import { decodeAnswerFromUrl } from "@/lib/shareLinks";
import { CATEGORIES, type CategoryId } from "@/lib/categories";

/**
 * Receives an answer-link the hider sends back: a URL of the form
 * `/?a=<encoded JSON>` where the payload is
 * `{ key: questionKey, answer: Partial<questionData> }`.
 *
 * On mount we:
 *   1. Parse `?a=` from the current URL.
 *   2. Find the matching question by `key`.
 *   3. Merge the answer fields into that question's `data`.
 *   4. Flip `drag: false` so the map immediately applies the eliminating
 *      effect — this is the "committed" state defined in the other
 *      direction (the seeker tapping Inside/Outside).
 *   5. Strip `?a=` from the URL via history.replaceState so a refresh
 *      doesn't re-apply the same answer.
 *   6. Toast confirmation so the seeker knows the link was processed.
 *
 * Renders nothing. Drop into the layout alongside Map / BottomNav as a
 * client:only island.
 */
export function AnswerLinkReader() {
    useEffect(() => {
        try {
            const params = new URLSearchParams(window.location.search);
            const payload = decodeAnswerFromUrl(params);
            if (!payload) return;

            const list = questions.get();
            const target = list.find((q) => q.key === payload.key);

            if (!target) {
                toast.error(
                    "Got an answer link, but I don't have the matching question saved. Was it asked on a different device?",
                    { autoClose: 5000, toastId: "answer-link-no-match" },
                );
            } else {
                // Merge the hider's answer fields onto the question data,
                // then mark it committed. The card UIs read `data.drag` to
                // decide whether to apply the elimination to the map.
                Object.assign(target.data, payload.answer, { drag: false });
                questionModified();

                const catLabel =
                    CATEGORIES[target.id as CategoryId]?.label ?? "Question";
                toast.success(`Answer received for ${catLabel}.`, {
                    autoClose: 3000,
                    toastId: `answer-link-${payload.key}`,
                });
            }
        } catch (e) {
            // Best-effort — never throw out of an effect into the React tree.
            console.warn("AnswerLinkReader failed:", e);
        } finally {
            // Always clean `?a=` from the URL so the next refresh doesn't
            // re-trigger us with stale data. Keep other search params intact.
            try {
                const url = new URL(window.location.href);
                if (url.searchParams.has("a")) {
                    url.searchParams.delete("a");
                    window.history.replaceState(
                        {},
                        "",
                        url.pathname + url.search + url.hash,
                    );
                }
            } catch {
                /* noop */
            }
        }
    }, []);

    return null;
}

export default AnswerLinkReader;

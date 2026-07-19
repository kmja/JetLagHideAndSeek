import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { ArrowLeft, Loader2 } from "lucide-react";
import React from "react";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import {
    deepColor,
    QuestionOverlayCard,
} from "@/components/questionOverlayCard";
import { adminDivisionName, adminTierToOsmLevel } from "@/lib/adminDivisions";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    computeAskingRestrictions,
    seekerOnTransit,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import { receivedCurses } from "@/lib/seekerInbound";
import {
    addQuestion,
    addQuestionSignal,
    configuringQuestionKey,
    defaultCustomQuestions,
    defaultUnit,
    lastKnownPosition,
    mapContext,
    mapGeoLocation,
    questionModified,
    questions,
} from "@/lib/context";
import { type GameSize, gameSize, playArea } from "@/lib/gameSetup";
import {
    alternateQuestionTypes,
    askOncePerQuestion,
} from "@/lib/houseRules";
import { fitMapToRadius } from "@/lib/mapFit";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import {
    isHiderConnected,
    seekerResendQuestion,
} from "@/lib/multiplayer/store";
import {
    maybePromptForNotifications,
    SEEKER_NOTIFICATION_PROMPT,
} from "@/lib/notificationPrompt";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { useSubtypeAvailability } from "@/lib/subtypeAvailability";
import { getSubtypes, type SubtypeMeta } from "@/lib/subtypes";
import { applyUnitTemplates, gameRadius, resolvedUnits } from "@/lib/units";
import { cn } from "@/lib/utils";
import {
    cacheableFamilyForType,
    type FamilyKey,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";

import { ConfigureDialogContext } from "./configureDialogContext";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    PhotoQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";
import { ThermometerConfigureDialog } from "./ThermometerConfigureDialog";
import { Button } from "./ui/button";

/**
 * On-tap warm-up for a category's reference data. This is the
 * lightweight cousin of the hiding-period `preloadDuringHidingPeriod`
 * orchestrator: when the seeker opens a category's subtype picker we
 * make sure that category's families are warming, in case the hiding-
 * period preload was skipped (late join, solo testing) or failed.
 *
 * Routes through the SAME `prefetchCategory` path the hiding-period
 * preload and the on-answer reference lookup use, so there's one
 * cache, one set of keys, and one status surface — no separate query
 * shape (the old version fired a differently-quoted `[tag=value]`
 * query that never shared keys with anything). Deduped + silent, so a
 * cache hit is a no-op and a failure never toasts.
 */
function preloadSubtypeData(
    category: "matching" | "measuring" | "tentacles",
    size: GameSize,
) {
    const subtypes = getSubtypes(category, size);
    if (!subtypes) return;
    const families = new Set<FamilyKey>();
    for (const s of subtypes) {
        const fam = cacheableFamilyForType(s.value);
        if (fam) families.add(fam);
    }
    for (const fam of families) {
        prefetchCategory(fam).catch(() => {});
    }
}

/**
 * Whether the pending question is ready to be sent. For matching and
 * measuring this means the seeker has either acquired a GPS fix or set
 * a location manually — both pathways write finite, non-zero numbers
 * into `data.lat` / `data.lng`. Before that, the coords are the 0,0
 * sentinel (per `runAddMatching` / `runAddMeasuring`) and the Send
 * button stays disabled. All other question types are always ready.
 */
function isPendingQuestionReady(
    q: { id: string; data: Record<string, unknown> } | null | undefined,
): boolean {
    if (!q) return false;
    if (q.id === "matching" || q.id === "measuring") {
        const lat = (q.data as { lat?: unknown }).lat;
        const lng = (q.data as { lng?: unknown }).lng;
        return (
            typeof lat === "number" &&
            Number.isFinite(lat) &&
            typeof lng === "number" &&
            Number.isFinite(lng) &&
            !(lat === 0 && lng === 0)
        );
    }
    return true;
}

/**
 * A single category tile in the Add Question picker.
 * Visual identity (color + icon) comes from CATEGORIES.
 */
/**
 * v355: rewrite the `admin-1` … `admin-4` subtype tiles with the
 * country-specific division name for the active play area. A German
 * player sees "Bundesland / Kreis / Gemeinde / Stadtteil"; a Japanese
 * player sees "Prefecture / City / Town / Ward". When we don't have
 * a row for the country, the generic "1st admin division" stays.
 * Non-admin subtypes pass through unchanged.
 */
const ADMIN_TIER_NUM: Record<string, 1 | 2 | 3 | 4> = {
    "admin-1": 1,
    "admin-2": 2,
    "admin-3": 3,
    "admin-4": 4,
};

/**
 * Rulebook-fixed tentacle radii (p37-38). The 2 km tier is the
 * Medium+Large set; the 25 km tier is the Large-only set (incl. Metro
 * Lines). Stamped onto the question at creation so a "Museum within
 * 2 km" is actually a 2 km question, not the schema's 15 km default.
 */
const TENTACLE_RADIUS_KM: Record<string, number> = {
    museum: 2,
    library: 2,
    cinema: 2,
    hospital: 2,
    metro: 25,
    zoo: 25,
    aquarium: 25,
    theme_park: 25,
};
/** Measuring "closer/further to a <tier> border" — the tier the border
 *  subtype refers to, so it gets the same country-specific label as the
 *  matching admin tiles (v869). admin1-border = tier 1 (state/canton/…),
 *  admin2-border = tier 2 (county/district/…). */
const ADMIN_BORDER_TIER_NUM: Record<string, 1 | 2> = {
    "admin1-border": 1,
    "admin2-border": 2,
};

function localizeAdminSubtype(
    subtype: SubtypeMeta,
    iso: string | undefined,
): SubtypeMeta {
    // Measuring admin-division BORDER subtypes: relabel "1st admin div.
    // border" → "State border" / "County border" etc. for the play area's
    // country, matching the matching-question admin tiles.
    const borderTier = ADMIN_BORDER_TIER_NUM[subtype.value];
    if (borderTier && iso) {
        const level = adminTierToOsmLevel(iso, borderTier);
        const localised = adminDivisionName(iso, level);
        if (!localised.startsWith("OSM") && !localised.includes("admin division")) {
            // Drop any parenthetical (e.g. "County (Län)") for a compact
            // "<Tier> border" label.
            const base = localised.replace(/\s*\(.*\)\s*$/, "");
            return { ...subtype, label: `${base} border` };
        }
        return subtype;
    }
    const tier = ADMIN_TIER_NUM[subtype.value];
    if (!tier || !iso) return subtype;
    const level = adminTierToOsmLevel(iso, tier);
    const localised = adminDivisionName(iso, level);
    // Only relabel when we have a country-specific name — the generic
    // fallback already lives in the static SUBTYPES table, so swapping
    // it back in here would be a no-op.
    if (localised.startsWith("OSM") || localised.includes("admin division")) {
        return subtype;
    }
    return { ...subtype, label: localised };
}

const SubtypeTile = ({
    category,
    subtype,
    onClick,
    disabled,
    blockedReason,
    repeatMultiplier,
}: {
    category: CategoryId;
    subtype: SubtypeMeta;
    onClick: () => void;
    disabled?: boolean;
    blockedReason?: string;
    /** Rulebook p65 repeat-cost multiplier. >1 → render a "Repeat · N×"
     *  badge so the seeker sees the cost before tapping. */
    repeatMultiplier?: number;
}) => {
    const $units = useStore(resolvedUnits);
    const showRepeat =
        !disabled && repeatMultiplier !== undefined && repeatMultiplier > 1;
    // v747: the subtype picker now uses the SAME QuestionOverlayCard chrome as
    // on-map overlays + the questions list (solid category-colour icon block,
    // big deep-colour label, detail line) so the whole add-question flow reads
    // as one system. The repeat-cost multiplier rides the card's right slot.
    // v972: render any {{km:}} / {{kmh:}} distance templates in the subtype
    // description in the selected unit system.
    return (
        <QuestionOverlayCard
            categoryId={category}
            flat
            summary={{
                bigLabel: subtype.label,
                detail:
                    blockedReason ??
                    applyUnitTemplates(subtype.description ?? "", $units),
                icon: subtype.icon,
            }}
            onClick={disabled ? undefined : onClick}
            ariaLabel={`Choose ${subtype.label}`}
            right={
                showRepeat ? (
                    <span
                        className="inline-flex items-center justify-center px-1.5 h-5 rounded-sm bg-yellow-500/90 text-black text-[11px] font-poppins font-bold leading-none"
                        title={`Repeat: hider runs the draw-keep cycle ${repeatMultiplier}× (rulebook p65)`}
                    >
                        {repeatMultiplier}×
                    </span>
                ) : undefined
            }
            className={cn(
                "hover:-translate-y-[1px]",
                disabled && "opacity-50 cursor-not-allowed",
            )}
        />
    );
};

const CategoryTile = ({
    category,
    description,
    onClick,
    disabled,
    className,
    blockedReason,
}: {
    category: CategoryId;
    description: string;
    onClick: () => void;
    disabled?: boolean;
    className?: string;
    blockedReason?: string;
}) => {
    const meta = CATEGORIES[category];
    // v747: the category picker uses the shared QuestionOverlayCard chrome
    // (matches the on-map overlays + the questions list) — solid category-
    // colour icon block, big deep-colour label, and the prompt as the detail
    // line — so the add-question flow looks like the rest of the app.
    return (
        <QuestionOverlayCard
            categoryId={category}
            flat
            summary={{
                bigLabel: meta.label,
                detail: blockedReason ?? description,
                icon: meta.icon,
            }}
            onClick={disabled ? undefined : onClick}
            ariaLabel={`Add ${meta.label} question`}
            className={cn(
                "hover:-translate-y-[1px]",
                disabled && "opacity-50 cursor-not-allowed",
                className,
            )}
        />
    );
};

export const AddQuestionDialog = ({
    children,
    respondToSignal = false,
}: {
    children: React.ReactNode;
    /** v873: when true, this instance opens whenever `addQuestionSignal`
     *  bumps — used by the always-mounted BottomNav instance so the Questions
     *  drawer's "New" button can open the dialog WITHOUT nesting its vaul
     *  drawer inside the drawer (the "first question not sent" bug). Exactly
     *  ONE mounted instance should set this. */
    respondToSignal?: boolean;
}) => {
    const $questions = useStore(questions);
    const $gameSize = useStore(gameSize);
    // v355: country-aware labels on the admin-division subtype tiles.
    const $mapGeo = useStore(mapGeoLocation);
    // Curse enforcement (v621): some active curses block certain question
    // categories (Drained Brain / Spotty Memory) or all asking (Urban
    // Explorer on transit, or Spotty Memory before the seekers roll).
    const $curses = useStore(receivedCurses);
    const $onTransit = useStore(seekerOnTransit);
    const $spottyCategory = useStore(spottyMemoryCategory);
    const curseBlock = computeAskingRestrictions($curses, {
        onTransit: $onTransit,
        spottyCategory: $spottyCategory,
    });
    const [open, setOpen] = React.useState(false);
    // v873: open in response to the shared signal (BottomNav instance only),
    // so the Questions drawer can close itself and delegate opening here.
    const $addSignal = useStore(addQuestionSignal);
    const lastAddSignal = React.useRef($addSignal);
    React.useEffect(() => {
        if (!respondToSignal) return;
        if ($addSignal !== lastAddSignal.current) {
            lastAddSignal.current = $addSignal;
            if ($addSignal > 0) setOpen(true);
        }
    }, [$addSignal, respondToSignal]);
    // Step 2 of the add flow: when the user picks a category that has
    // multiple subtypes (matching / measuring / tentacles / photo), we
    // show a subtype picker before opening the configure dialog. Null when
    // we're either on step 1 (category picker) or past step 2 (configure).
    const [subtypePickerFor, setSubtypePickerFor] = React.useState<
        "matching" | "measuring" | "tentacles" | "photo" | null
    >(null);
    // Per-subtype availability for the open subtype picker: greys out
    // reference types with too few instances inside the play area to make
    // a meaningful question (e.g. a single aquarium, or no airports).
    const pickerSubtypeValues = React.useMemo(
        () =>
            (subtypePickerFor
                ? (getSubtypes(subtypePickerFor, $gameSize) ?? [])
                : []
            ).map((s) => s.value),
        [subtypePickerFor, $gameSize],
    );
    const subtypeAvailability = useSubtypeAvailability(
        subtypePickerFor,
        pickerSubtypeValues,
    );
    // Key of the just-added question awaiting Confirm/Cancel.
    const [pendingKey, setPendingKey] = React.useState<number | null>(null);
    // v339: thermometer now needs a target-distance + Start confirm
    // dialog before we capture GPS — no longer an immediate start.
    const [thermConfigureOpen, setThermConfigureOpen] = React.useState(false);

    const pendingQuestion =
        pendingKey !== null
            ? $questions.find((q) => q.key === pendingKey)
            : null;

    // v371: track the configure-dialog picker's readiness so the Send
    // button stays disabled until reference lookup / impact / tile paint
    // all settle. Reset to `false` on every new pending question, then
    // the picker (via ConfigureDialogContext) flips it true once ready.
    // Question types that don't mount a picker (thermometer / photo with
    // no LL config) bypass the gate via `pendingUsesPicker`.
    const [pickerReady, setPickerReady] = React.useState(false);
    // v611: unified loading. Hold ONE skeleton over the whole configure
    // body until the picker signals ready (reference resolved + impact +
    // tiles painted), so the dialog reveals all its info at once instead
    // of the reference box, then the map, popping in separately. The
    // timeout is a deadlock backstop: if the picker never readies (e.g.
    // GPS denied → the map never mounts and the manual place-search lives
    // under the skeleton), reveal anyway so the user isn't stuck.
    const [revealAnyway, setRevealAnyway] = React.useState(false);
    // v747: the picker reports WHICH steps are still pending, so the loading
    // veil shows labelled rows ("Loading map…", "Getting your location…")
    // instead of blank grey bars.
    const [loadingLabels, setLoadingLabels] = React.useState<string[]>([]);
    React.useEffect(() => {
        setPickerReady(false);
        setRevealAnyway(false);
        setLoadingLabels([]);
        if (pendingKey === null) return;
        const t = window.setTimeout(() => setRevealAnyway(true), 6000);
        return () => window.clearTimeout(t);
    }, [pendingKey]);
    // v823: publish which question is being configured so the seeker's
    // PendingAnswerOverlay can exclude this still-unsent draft (it lives in
    // the `questions` store as drag:true with no createdAt, which the overlay
    // would otherwise render as a "Couldn't send — tap retry" card behind the
    // dialog). Cleared when the dialog closes (pendingKey → null).
    React.useEffect(() => {
        configuringQuestionKey.set(pendingKey);
        return () => configuringQuestionKey.set(null);
    }, [pendingKey]);
    const pendingUsesPicker =
        pendingQuestion?.id === "matching" ||
        pendingQuestion?.id === "measuring" ||
        pendingQuestion?.id === "radius" ||
        pendingQuestion?.id === "tentacles";
    const configureCtxValue = React.useMemo(
        () => ({
            onPickerReady: setPickerReady,
            onLoadingStatus: setLoadingLabels,
        }),
        [],
    );

    // Rulebook enforcement, with two House Rules toggles —
    //
    // Rule 1 (rulebook p65): a question CAN be asked again at increased
    //         cost (2× the first repeat, 3× the next, …). The hider
    //         runs the draw-keep cycle that many times. House rule
    //         `askOncePerQuestion` flips this to a hard block (the
    //         previous app behaviour).
    //
    // Rule 2 (house rule only): alternate question categories. NOT in
    //         the printed rulebook — toggle via `alternateQuestionTypes`.
    //
    // We track BOTH the set of used subtypes and a per-subtype count so
    // the picker can grey out (hard-block mode) or surface a "Repeat ·
    // N×" badge (rulebook mode).
    const $askOnce = useStore(askOncePerQuestion);
    const $alternate = useStore(alternateQuestionTypes);
    const subtypeCounts = React.useMemo(() => {
        const map: Record<string, Record<string, number>> = {
            matching: {},
            measuring: {},
            tentacles: {},
            photo: {},
        };
        const bump = (cat: string, key: string) => {
            map[cat][key] = (map[cat][key] ?? 0) + 1;
        };
        for (const q of $questions) {
            const d = q.data as {
                type?: string;
                locationType?: string;
                randomizedAway?: boolean;
            };
            // v673: a question that was RANDOMIZED away is NOT considered
            // asked (rulebook p376) — it can be re-asked at its original
            // cost — so it must not count toward the repeat multiplier or
            // the hard-block set. The SUBSTITUTE it produced is a separate
            // entry that counts normally.
            if (d.randomizedAway === true) continue;
            if (q.id === "matching" || q.id === "measuring") {
                if (d.type) bump(q.id, d.type);
            } else if (q.id === "tentacles") {
                if (d.locationType) bump("tentacles", d.locationType);
            } else if (q.id === "photo") {
                if (d.type) bump("photo", d.type);
            }
        }
        return map;
    }, [$questions]);
    const usedSubtypes = React.useMemo(() => {
        const map: Record<string, Set<string>> = {
            matching: new Set(),
            measuring: new Set(),
            tentacles: new Set(),
            photo: new Set(),
        };
        for (const cat of Object.keys(map)) {
            for (const key of Object.keys(subtypeCounts[cat])) {
                map[cat].add(key);
            }
        }
        return map;
    }, [subtypeCounts]);

    const lastQuestionType = React.useMemo(
        () =>
            $questions.length > 0 ? $questions[$questions.length - 1].id : null,
        [$questions],
    );

    // Helper: get the most recently added question's key, then promote it
    // to the "pending confirm" state and close the category picker.
    //
    // We close the category picker first, then open the configure dialog
    // on the next tick. Two simultaneously-mounting Radix Dialogs confuse
    // Radix's body scroll-lock reference counting and leave
    // `pointer-events: none` stuck on <body> after both eventually close,
    // silently blocking every click on the rest of the UI (e.g. the
    // bottom-nav "Questions" button). The setTimeout gives Radix a tick
    // to finish cleanup before the second dialog mounts.
    const promoteLastQuestion = () => {
        const list = questions.get();
        if (list.length === 0) return;
        const lastKey = list[list.length - 1].key;
        // v979: claim the configuring-guard IMMEDIATELY (not via the
        // pendingKey effect, which only fires 150 ms later once the configure
        // dialog opens). The draft is already in the `questions` store as a
        // drag:true/no-createdAt entry, so during that gap — which stretches
        // to SECONDS when a heavy question (park / body-of-water) freezes the
        // main thread — PendingAnswerOverlay would show it as a bogus
        // "Couldn't send — tap retry" card even though nothing was sent.
        configuringQuestionKey.set(lastKey);
        setOpen(false);
        setTimeout(() => setPendingKey(lastKey), 150);
    };

    // (A stray `body{pointer-events:none}` left by Radix's close race is now
    // cleared globally by installBodyPointerEventsGuard — the picker/configure
    // sequencing in `promoteLastQuestion` still avoids provoking it, but no
    // per-handler clearing is needed here anymore.)

    const handleCancel = () => {
        if (pendingKey === null) return;
        questions.set(questions.get().filter((q) => q.key !== pendingKey));
        setPendingKey(null);
    };

    const handleConfirm = async () => {
        if (!pendingQuestion) {
            setPendingKey(null);
            return;
        }
        // v966: the transit-line question needs the seeker to pick the route
        // they're riding before it can be sent (its stops drive the answer).
        if (
            pendingQuestion.id === "matching" &&
            (pendingQuestion.data as { type?: string }).type ===
                "same-train-line" &&
            !(pendingQuestion.data as { transitRoute?: unknown }).transitRoute
        ) {
            toast.error(
                "Pick the transit line you're riding before sending this question.",
            );
            return;
        }
        // Snapshot the question before closing — pendingQuestion will become
        // null once we clear the dialog state.
        const q = pendingQuestion;
        const meta = CATEGORIES[q.id as CategoryId];
        setPendingKey(null);

        // v348: questions are LOCAL-ONLY until the seeker confirms in
        // the configure dialog. The local add happened in runAdd* via
        // context.addQuestion (no MP push). NOW we stamp createdAt —
        // which both starts the hider's answer-window countdown AND
        // locks all subsequent edits via the cards' `disabled` logic
        // (see cards/base.tsx). The seeker sets the location once,
        // sends, and the question is fixed thereafter.
        if (multiplayerEnabled.get()) {
            (q.data as { createdAt?: number }).createdAt = Date.now();
            questionModified();
            seekerResendQuestion(q.key);
            // Successful send is silent now — the pending-answer overlay
            // already shows the question is out and counting down, so a
            // "Sent to hider" toast was redundant noise. The offline case
            // still toasts because delivery is genuinely deferred.
            if (!isHiderConnected()) {
                toast.info(
                    "Sent — hider's currently offline, they'll receive it on reconnect.",
                    { autoClose: 2500 },
                );
            }
            // The seeker just sent a question and is now waiting on the
            // answer — the ideal moment to offer background notifications
            // (once), so they hear the reply without watching the app.
            maybePromptForNotifications(SEEKER_NOTIFICATION_PROMPT);
            return;
        }

        // Auto-share the question with the hider. v375: this fallback
        // path is for the case where no multiplayer session is active —
        // there's no in-app channel to push the question through, so we
        // copy the link to the clipboard for the seeker to send manually
        // (text/DM/whatever). Crucially we do NOT call `shareOrCopy` /
        // `navigator.share` here: when this fires automatically on Send,
        // opening the OS share sheet feels like a bug (the user just
        // pressed an in-app button and got a system modal). The card's
        // explicit "Share via" button still uses `shareOrCopy` — that's a
        // user-initiated share intent and the OS sheet is the right UX
        // there. createdAt is stamped on a successful copy so the hider's
        // answer-window countdown starts then, matching the old behaviour
        // when `shareOrCopy` returned method: "copy".
        const url = encodeQuestionForHider(q);
        let copied = false;
        try {
            if (typeof navigator?.clipboard?.writeText === "function") {
                await navigator.clipboard.writeText(url);
                copied = true;
            }
        } catch {
            /* fall through to the failed-copy toast */
        }
        if (copied) {
            (q.data as { createdAt?: number }).createdAt = Date.now();
            questionModified();
            toast.info(
                "Question added. Join an online game from the lobby to send through the app — for now, the link is on your clipboard.",
                { autoClose: 3500 },
            );
        } else {
            toast.error(
                "Couldn't copy the question link. Open the question card and use Share to send it manually.",
                { autoClose: 4000 },
            );
        }
        // createdAt stays unset on a failed copy — the countdown won't
        // start until the seeker manually shares from the questions
        // panel, which also stamps createdAt on success.
    };

    // None of these helpers stamp `createdAt` upfront — the answer-window
    // countdown only starts once the question is actually delivered to the
    // hider. `handleConfirm` (configure dialog) and the per-question share
    // button (questions panel) are the two paths that stamp it post-share.
    // Resolve a center point for new questions. Prefer the live map
    // viewport (so the seeker drops the question where they're looking),
    // but fall back to the play-area centroid when the map ref isn't
    // ready yet — e.g. on initial mount before MapLibre has registered
    // its context. Without this fallback, tapping a subtype tile was a
    // silent no-op for users who picked a category before the map
    // finished its first frame.
    const resolveCenter = (): { lat: number; lng: number } | null => {
        const map = mapContext.get();
        if (map) {
            const c = map.getCenter();
            return { lat: c.lat, lng: c.lng };
        }
        const pa = playArea.get();
        if (pa) return { lat: pa.lat, lng: pa.lng };
        return null;
    };

    // GPS-seeded center for question types whose answer depends on
    // the seeker's actual position (radar, matching, measuring).
    // Prefers the seeker's most recent GPS fix, then the map center,
    // then the play-area centroid. Radar in particular feels broken
    // when the new circle drops on the last-panned map view rather
    // than the seeker's location, so we ask GPS first here.
    const resolveSeekerCenter = (): { lat: number; lng: number } | null => {
        const gps = lastKnownPosition.get();
        if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lng)) {
            return { lat: gps.lat, lng: gps.lng };
        }
        return resolveCenter();
    };

    const runAddRadius = () => {
        const center = resolveSeekerCenter();
        if (!center) return false;
        const map = mapContext.get();
        // Default to the 5 km tier — the previous 10 km starting point
        // tended to swallow most cities at typical zoom levels. v972:
        // seed in the SELECTED unit system (5 km → 3 mi imperial) so the
        // carousel opens on the matching size rather than a mismatched
        // km value.
        const seed = gameRadius(5000, resolvedUnits.get());
        addQuestion({
            id: "radius",
            data: {
                lat: center.lat,
                lng: center.lng,
                radius: seed.radius,
                unit: seed.unit,
            },
        });
        // Fit the map to the new radius so the entire circle is visible.
        if (map) {
            fitMapToRadius(map, center.lat, center.lng, seed.radius, seed.unit);
        }
        return true;
    };

    // v339 removed: runAddThermometer captured the MAP CENTRE as the
    // thermometer's starting point, which broke rulebook p31 — the
    // start point is the seeker's current GPS, full stop. Thermometer
    // creation now goes through ThermometerConfigureDialog, which
    // requests a fresh GPS fix on confirm.

    const runAddTentacles = (subtype?: string) => {
        const center = resolveCenter();
        if (!center) return false;
        // Tentacles uses `locationType` as the type field (unlike matching
        // and measuring which use `type`). When the user picks a subtype in
        // step 2 we set it here so the resulting question has the right
        // place category baked in.
        // v670: stamp the rulebook's FIXED tentacle radius per tier
        // (p37-38) — the 2 km tier (museum/library/cinema/hospital) and
        // the 25 km tier (metro/zoo/aquarium/amusement park). Without
        // this every tentacle inherited the schema's 15 km default, so a
        // "Museum within 2 km" was actually built (and eliminated) as a
        // 15 km question. Custom tentacles keep the default.
        const radiusKm = subtype
            ? TENTACLE_RADIUS_KM[subtype]
            : undefined;
        // v972: stamp the tentacle radius in the SELECTED unit system —
        // 2 km → 1 mi, 25 km → 15 mi for an imperial player. The value +
        // unit are stored on the question, so it grades + displays in
        // that unit for everyone.
        const radiusFields =
            radiusKm !== undefined
                ? gameRadius(radiusKm * 1000, resolvedUnits.get())
                : {};
        // Cast to never on each branch — the schema-side discriminated
        // union is too narrow for TS to verify the dynamic subtype
        // string. `addQuestion` runs the value through Zod parsing at
        // runtime so an invalid subtype would surface as a parse error
        // long before it could corrupt state.
        addQuestion({
            id: "tentacles",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: center.lat,
                      lng: center.lng,
                      locationType: subtype ?? "custom",
                      places: [],
                      ...radiusFields,
                  } as never)
                : ({
                      lat: center.lat,
                      lng: center.lng,
                      ...(subtype ? { locationType: subtype } : {}),
                      ...radiusFields,
                  } as never),
        });
        return true;
    };

    const runAddMatching = (subtype?: string) => {
        // Seed from the latest GPS fix when we have one — the configure
        // dialog can then fire the "nearest reference" lookup
        // immediately instead of waiting for the picker's own GPS pass
        // to land first. If we have no fix yet, fall back to the 0,0
        // sentinel so the Confirm button stays disabled until a real
        // location is chosen (GPS or manual place-search). 0,0 is
        // preferred over NaN because the Zod schema rejects NaN at
        // parse time.
        const seed = lastKnownPosition.get();
        // v343: rulebook p18 admin-division picker shortcuts. They map
        // to the existing zone schema (cat.adminLevel) — the elimination
        // is identical to a manually-built zone question, just with a
        // pre-filled OSM admin_level. v355: the tier→level mapping is now
        // country-aware (`adminTierToOsmLevel`) so Japan picks 4/7/8/9
        // for State/City/Town/Ward while Germany still gets 4/6/8/9. The
        // seeker can still override via the configure card's adminLevel
        // dropdown for the edge cases.
        const ADMIN_TIER: Record<string, 1 | 2 | 3 | 4> = {
            "admin-1": 1,
            "admin-2": 2,
            "admin-3": 3,
            "admin-4": 4,
        };
        if (subtype && subtype in ADMIN_TIER) {
            const iso = mapGeoLocation.get()?.properties?.countrycode;
            addQuestion({
                id: "matching",
                data: {
                    lat: seed?.lat ?? 0,
                    lng: seed?.lng ?? 0,
                    type: "zone",
                    cat: {
                        adminLevel: adminTierToOsmLevel(
                            iso,
                            ADMIN_TIER[subtype],
                        ),
                    },
                } as never,
            });
            return true;
        }
        addQuestion({
            id: "matching",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: seed?.lat ?? 0,
                      lng: seed?.lng ?? 0,
                      type: subtype ?? "custom-points",
                  } as never)
                : ({
                      lat: seed?.lat ?? 0,
                      lng: seed?.lng ?? 0,
                      ...(subtype ? { type: subtype } : {}),
                  } as never),
        });
        return true;
    };

    const runAddMeasuring = (subtype?: string) => {
        // See runAddMatching — same rule: prefer the last GPS fix so
        // the reference lookup can start immediately; 0,0 sentinel
        // when we have nothing yet.
        const seed = lastKnownPosition.get();
        addQuestion({
            id: "measuring",
            data: defaultCustomQuestions.get()
                ? ({
                      lat: seed?.lat ?? 0,
                      lng: seed?.lng ?? 0,
                      type: subtype ?? "custom-measure",
                  } as never)
                : ({
                      lat: seed?.lat ?? 0,
                      lng: seed?.lng ?? 0,
                      ...(subtype ? { type: subtype } : {}),
                  } as never),
        });
        return true;
    };

    /**
     * Photo questions don't need a map location — the photo IS the answer.
     * We just create the question with the chosen subtype and drag:true
     * (awaiting answer). The hider will eventually attach a photo (or the
     * seeker will mark answered manually if the photo came via SMS).
     */
    const runAddPhoto = (subtype?: string) => {
        addQuestion({
            id: "photo",
            data: {
                type: subtype ?? "tree",
            },
        });
        return true;
    };

    return (
        <>
            <Drawer
                open={open}
                onOpenChange={setOpen}
                shouldScaleBackground={false}
            >
                <DrawerTrigger asChild>{children}</DrawerTrigger>
                {/* z-[1048]: this drawer is often opened from INSIDE the
                    mobile Questions drawer (content z-[1045]); raise both
                    overlay and content above it so the category picker
                    stacks on top instead of behind. Stays below the
                    Sheet/Dialog tier (z-[1050]). */}
                <DrawerContent
                    className="z-[1048]"
                    overlayClassName="z-[1048]"
                >
                    <div className="overflow-y-auto px-6 pt-2 pb-6 max-h-[82vh]">
                        <DrawerTitle>Add Question</DrawerTitle>
                        <DrawerDescription>Pick a category.</DrawerDescription>

                        {/* Curse block notice (v621) — when an active curse
                            disables all asking (Urban Explorer on transit /
                            Spotty Memory before rolling), explain why every
                            tile is greyed out. */}
                        {curseBlock.blockedAll && curseBlock.reason && (
                            <div className="mt-2 rounded-sm border-2 border-purple-500/50 bg-purple-500/10 px-3 py-2 text-xs text-purple-200 leading-snug">
                                {curseBlock.reason}
                            </div>
                        )}

                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {(() => {
                                // Rulebook (p38): "Tentacle questions cannot be used
                                // in SMALL games." This is the only category-level
                                // size restriction in the book.
                                const tentacleBlockedSize =
                                    $gameSize === "small";
                                // Rulebook implicitly: only one thermometer can be in
                                // progress at a time, since a thermometer is one
                                // start point + one end point per question. If a
                                // started thermometer exists, block adding another.
                                const thermInProgress = $questions.some(
                                    (q) =>
                                        q.id === "thermometer" &&
                                        (q.data as { status?: string })
                                            .status === "started",
                                );
                                // Alternation is a HOUSE RULE — off by
                                // default (rulebook allows back-to-back
                                // same-category). Only gate when the
                                // user has turned the toggle on.
                                const alternationReason = (label: string) =>
                                    `House rule: you just asked a ${label} question — alternate categories first.`;
                                const matchingBlockedByLast =
                                    $alternate && lastQuestionType === "matching";
                                const measuringBlockedByLast =
                                    $alternate && lastQuestionType === "measuring";
                                const radiusBlockedByLast =
                                    $alternate && lastQuestionType === "radius";
                                const thermometerBlockedByLast =
                                    $alternate && lastQuestionType === "thermometer";
                                const photoBlockedByLast =
                                    $alternate && lastQuestionType === "photo";
                                const tentaclesBlockedByLast =
                                    $alternate && lastQuestionType === "tentacles";
                                // Curse gating (v621): a full block (Urban
                                // Explorer on transit / Spotty Memory before
                                // rolling) disables every tile; otherwise just
                                // the specific cursed categories (Drained Brain
                                // / Spotty Memory's current roll).
                                const curseReason = (
                                    cat: CategoryId,
                                ): string | undefined =>
                                    curseBlock.blockedAll
                                        ? curseBlock.reason
                                        : curseBlock.disabledCategories.has(cat)
                                          ? "Disabled by an active curse."
                                          : undefined;
                                return (
                                    <>
                                        <CategoryTile
                                            category="matching"
                                            description="Is your nearest ___ the same as mine?"
                                            onClick={() => {
                                                preloadSubtypeData(
                                                    "matching",
                                                    $gameSize,
                                                );
                                                setSubtypePickerFor("matching");
                                            }}
                                            disabled={
                                                matchingBlockedByLast ||
                                                curseReason("matching") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                matchingBlockedByLast
                                                    ? alternationReason(
                                                          "matching",
                                                      )
                                                    : curseReason("matching")
                                            }
                                        />
                                        <CategoryTile
                                            category="measuring"
                                            description="Are you closer or further to ___ than me?"
                                            onClick={() => {
                                                preloadSubtypeData(
                                                    "measuring",
                                                    $gameSize,
                                                );
                                                setSubtypePickerFor(
                                                    "measuring",
                                                );
                                            }}
                                            disabled={
                                                measuringBlockedByLast ||
                                                curseReason("measuring") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                measuringBlockedByLast
                                                    ? alternationReason(
                                                          "measuring",
                                                      )
                                                    : curseReason("measuring")
                                            }
                                        />
                                        <CategoryTile
                                            category="radius"
                                            description="Are you within ___ of me?"
                                            onClick={() => {
                                                if (runAddRadius())
                                                    promoteLastQuestion();
                                            }}
                                            disabled={
                                                radiusBlockedByLast ||
                                                curseReason("radius") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                radiusBlockedByLast
                                                    ? alternationReason("radar")
                                                    : curseReason("radius")
                                            }
                                        />
                                        <CategoryTile
                                            category="thermometer"
                                            description="After traveling ___, am I hotter or colder?"
                                            onClick={() => {
                                                // v339: open the configure
                                                // dialog instead of starting
                                                // immediately. The dialog asks
                                                // for a target distance + grabs
                                                // a fresh GPS fix before
                                                // committing the question.
                                                setOpen(false);
                                                setThermConfigureOpen(true);
                                            }}
                                            disabled={
                                                thermInProgress ||
                                                thermometerBlockedByLast ||
                                                curseReason("thermometer") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                thermInProgress
                                                    ? "A thermometer is already in progress — finish it before starting another"
                                                    : thermometerBlockedByLast
                                                      ? alternationReason(
                                                            "thermometer",
                                                        )
                                                      : curseReason(
                                                            "thermometer",
                                                        )
                                            }
                                        />
                                        <CategoryTile
                                            category="photo"
                                            description="Send me a photo of ___."
                                            onClick={() => {
                                                setSubtypePickerFor("photo");
                                            }}
                                            disabled={
                                                photoBlockedByLast ||
                                                curseReason("photo") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                photoBlockedByLast
                                                    ? alternationReason("photo")
                                                    : curseReason("photo")
                                            }
                                        />
                                        <CategoryTile
                                            category="tentacles"
                                            description="Within ___ km of me, which ___ are you nearest to?"
                                            onClick={() => {
                                                preloadSubtypeData(
                                                    "tentacles",
                                                    $gameSize,
                                                );
                                                setSubtypePickerFor(
                                                    "tentacles",
                                                );
                                            }}
                                            disabled={
                                                tentacleBlockedSize ||
                                                tentaclesBlockedByLast ||
                                                curseReason("tentacles") !==
                                                    undefined
                                            }
                                            blockedReason={
                                                tentacleBlockedSize
                                                    ? "Tentacle questions aren't used in Small games (rulebook p38)."
                                                    : tentaclesBlockedByLast
                                                      ? alternationReason(
                                                            "tentacles",
                                                        )
                                                      : curseReason(
                                                            "tentacles",
                                                        )
                                            }
                                        />
                                    </>
                                );
                            })()}
                        </div>

                        {/* House rules reminders — rulebook p13. Google Street View
                    is banned (too powerful for photo matches and station
                    verification); questions must be asked one at a time. */}
                        <div className="mt-3 pt-3 border-t border-border text-[11px] leading-snug text-muted-foreground space-y-0.5">
                            <div>
                                <span className="font-semibold text-foreground">
                                    No Google Street View
                                </span>{" "}
                                — the only banned research tool.
                            </div>
                            <div>
                                One question at a time — wait for the hider's
                                answer before asking the next.
                            </div>
                        </div>
                    </div>
                </DrawerContent>
            </Drawer>

            {/* Step 2: subtype picker for matching/measuring/tentacles. The
                user lands here after tapping a category that has multiple
                subtypes. Picking a tile adds the question with that subtype
                preselected, then opens the configure dialog. */}
            <Drawer
                open={subtypePickerFor !== null}
                onOpenChange={(o) => {
                    if (!o) setSubtypePickerFor(null);
                }}
                shouldScaleBackground={false}
            >
                <DrawerContent
                    overlayClassName="z-[1048]"
                    className={cn(
                        "z-[1048]",
                        "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                        "flex flex-col p-0 gap-0 max-h-[88vh]",
                    )}
                >
                    {subtypePickerFor &&
                        (() => {
                            const meta = CATEGORIES[subtypePickerFor];
                            const subtypes = getSubtypes(
                                subtypePickerFor,
                                $gameSize,
                            );
                            // Rulebook-template description for this category.
                            // Lives here (subdialog header) rather than on the
                            // small category tiles so the grid stays clean.
                            const templateByCategory: Record<string, string> = {
                                matching:
                                    "Is your nearest ___ the same as mine?",
                                measuring:
                                    "Are you closer or further to ___ than me?",
                                tentacles:
                                    "Within ___ km of me, which ___ are you nearest to?",
                                photo: "Send me a photo of ___.",
                            };
                            const template =
                                templateByCategory[subtypePickerFor];
                            return (
                                <>
                                    <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                                        {/* Back button + a title/description
                                            COLUMN so the description aligns
                                            with the title (v892: the category
                                            icon block was removed). */}
                                        <div className="flex items-center gap-4">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSubtypePickerFor(null);
                                                    setOpen(true);
                                                }}
                                                aria-label="Back to categories"
                                                title="Back to categories"
                                                className={cn(
                                                    // v981: sized to match the
                                                    // two-line title+description
                                                    // block beside it, with more
                                                    // breathing room (gap-4).
                                                    "inline-flex items-center justify-center w-12 h-12 rounded-lg shrink-0",
                                                    "bg-secondary text-foreground hover:bg-accent",
                                                    "border border-border transition-colors",
                                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                                )}
                                            >
                                                <ArrowLeft
                                                    size={22}
                                                    strokeWidth={2.5}
                                                />
                                            </button>
                                            <div className="min-w-0 flex-1">
                                                <DrawerTitle
                                                    className="font-poppins font-extrabold uppercase tracking-tight text-xl leading-none"
                                                    style={{
                                                        color: deepColor(
                                                            meta.color,
                                                        ),
                                                    }}
                                                >
                                                    {meta.label}
                                                </DrawerTitle>
                                                <DrawerDescription className="mt-1.5 text-sm text-muted-foreground leading-snug">
                                                    {template ??
                                                        `Pick a ${meta.label.toLowerCase()} type.`}
                                                </DrawerDescription>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                            {subtypes?.map((subtype) => {
                                                // Per-subtype repeat count:
                                                // 0 = never asked; N > 0 =
                                                // the next ask is the
                                                // (N+1)-th and costs (N+1)×
                                                // per rulebook p65. The
                                                // House Rule
                                                // `askOncePerQuestion`
                                                // flips the rulebook
                                                // pay-N× into a hard block.
                                                const askedTimes =
                                                    subtypeCounts[
                                                        subtypePickerFor
                                                    ]?.[subtype.value] ?? 0;
                                                const subtypeUsed =
                                                    askedTimes > 0;
                                                const hardBlock =
                                                    $askOnce && subtypeUsed;
                                                const repeatMult = askedTimes + 1;
                                                // Too few of this reference
                                                // inside the play area to ask
                                                // a meaningful question.
                                                const avail =
                                                    subtypeAvailability[
                                                        subtype.value
                                                    ];
                                                const tooFew = Boolean(
                                                    avail && !avail.available,
                                                );
                                                // v907: Drained Brain can block
                                                // this SPECIFIC question.
                                                const curseBlockedSubtype =
                                                    curseBlock.disabledSubtypes.has(
                                                        `${subtypePickerFor}/${subtype.value}`,
                                                    );
                                                const isAdminTile =
                                                    /^admin-[1-4]$/.test(
                                                        subtype.value,
                                                    );
                                                // Presence-gated line references
                                                // (measuring): disabled when the
                                                // reference isn't in/near the play
                                                // area — NOT a "count < 2" case, so
                                                // don't say "only one" (measuring
                                                // needs just one). v899.
                                                const isPresenceLine =
                                                    subtype.value ===
                                                        "highspeed-measure-shinkansen" ||
                                                    subtype.value ===
                                                        "international-border";
                                                // Reason text kept GENERIC — it
                                                // never names the question type
                                                // (v899), since the tile already
                                                // shows what it is.
                                                const tooFewReason = tooFew
                                                    ? isAdminTile
                                                        ? "The whole play area is in one region — this can't narrow the map."
                                                        : subtype.value ===
                                                            "coastline"
                                                          ? "No coastline in the play area — this can't narrow the map."
                                                          : subtype.value ===
                                                              "same-landmass"
                                                            ? "The play area is a single landmass — this can't narrow the map."
                                                            : isPresenceLine
                                                              ? "None in the play area — this can't narrow the map."
                                                              : avail!.count === 0
                                                                ? "None in the play area to ask about."
                                                                : "Only one in the play area — not enough to ask this."
                                                    : undefined;
                                                return (
                                                    <SubtypeTile
                                                        key={subtype.value}
                                                        category={
                                                            subtypePickerFor
                                                        }
                                                        subtype={localizeAdminSubtype(
                                                            subtype,
                                                            $mapGeo?.properties
                                                                ?.countrycode,
                                                        )}
                                                        disabled={
                                                            hardBlock ||
                                                            tooFew ||
                                                            curseBlockedSubtype
                                                        }
                                                        repeatMultiplier={
                                                            subtypeUsed
                                                                ? repeatMult
                                                                : undefined
                                                        }
                                                        blockedReason={
                                                            curseBlockedSubtype
                                                                ? "Blocked by Curse of the Drained Brain for the rest of the run."
                                                                : hardBlock
                                                                  ? "House rule: each question can only be asked once per game."
                                                                  : tooFewReason
                                                        }
                                                        onClick={() => {
                                                            const cat =
                                                                subtypePickerFor;
                                                            let ok = false;
                                                            if (
                                                                cat ===
                                                                "matching"
                                                            )
                                                                ok =
                                                                    runAddMatching(
                                                                        subtype.value,
                                                                    );
                                                            else if (
                                                                cat ===
                                                                "measuring"
                                                            )
                                                                ok =
                                                                    runAddMeasuring(
                                                                        subtype.value,
                                                                    );
                                                            else if (
                                                                cat ===
                                                                "tentacles"
                                                            )
                                                                ok =
                                                                    runAddTentacles(
                                                                        subtype.value,
                                                                    );
                                                            else if (
                                                                cat === "photo"
                                                            )
                                                                ok =
                                                                    runAddPhoto(
                                                                        subtype.value,
                                                                    );
                                                            if (ok) {
                                                                setSubtypePickerFor(
                                                                    null,
                                                                );
                                                                promoteLastQuestion();
                                                            } else {
                                                                // Surfaces a previously-silent
                                                                // failure path: if neither map
                                                                // nor play area resolve a
                                                                // center, tell the seeker
                                                                // instead of doing nothing.
                                                                toast.error(
                                                                    "Couldn't add the question — map not ready. Try again in a moment.",
                                                                );
                                                            }
                                                        }}
                                                    />
                                                );
                                            })}
                                        </div>
                                    </div>
                                </>
                            );
                        })()}
                </DrawerContent>
            </Drawer>

            <ConfigureDialogContext.Provider value={configureCtxValue}>
                <Dialog
                    open={pendingKey !== null}
                    onOpenChange={(o) => {
                        if (!o) handleCancel();
                    }}
                >
                    <DialogContent
                        className={cn(
                            "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                            "flex flex-col p-0 gap-0",
                        )}
                    >
                        <div className="px-6 pt-6 pb-3 shrink-0 border-b border-border">
                            <DialogTitle>Configure question</DialogTitle>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-3 min-h-0 relative">
                            {/* v773: progressive reveal — NO full-body veil.
                                The question card (category header + config
                                controls) renders immediately; each async
                                section shows its OWN loader instead (the map
                                picker's MapTilesVeil, the nearest-reference
                                pill's spinner), so the dialog takes shape in
                                place rather than sitting behind one big
                                skeleton. The Send button still waits on
                                `pickerReady` (below), so nothing can be sent
                                before the location + map are ready. */}
                            <div>
                            {pendingQuestion &&
                                (() => {
                                    const q = pendingQuestion;
                                    switch (q.id) {
                                        case "radius":
                                            return (
                                                <RadiusQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        case "thermometer":
                                            return (
                                                <ThermometerQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        case "tentacles":
                                            return (
                                                <TentacleQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        case "matching":
                                            return (
                                                <MatchingQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        case "measuring":
                                            return (
                                                <MeasuringQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        case "photo":
                                            return (
                                                <PhotoQuestionComponent
                                                    data={q.data}
                                                    questionKey={q.key}
                                                    forceExpanded
                                                    compactAnswer
                                                />
                                            );
                                        default:
                                            return null;
                                    }
                                })()}
                            </div>
                        </div>

                        <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                            <Button variant="outline" onClick={handleCancel}>
                                Cancel
                            </Button>
                            <Button
                                onClick={handleConfirm}
                                disabled={
                                    !isPendingQuestionReady(pendingQuestion) ||
                                    (pendingUsesPicker && !pickerReady)
                                }
                            >
                                Send question
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </ConfigureDialogContext.Provider>
            <ThermometerConfigureDialog
                open={thermConfigureOpen}
                onOpenChange={setThermConfigureOpen}
            />
        </>
    );
};

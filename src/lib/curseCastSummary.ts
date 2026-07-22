/**
 * Shortened, HIDER-FACING curse descriptions for the Cast Curse dialog.
 *
 * The cast dialog is the hider's action screen — they're picking a place,
 * taking a photo, filming, choosing a word, etc. — so the full rulebook
 * paragraph (most of which describes what the SEEKERS must do afterwards)
 * is clutter there. This map holds a one-or-two-sentence gist per curse:
 *
 *   - Action curses (location / photo / film / rock tower / word / disable
 *     picks) → just the sentence describing the hider's action + the key
 *     constraint. The action UI + casting-cost box carry the rest.
 *   - Task/timed curses (no dialog action) → a single line stating what the
 *     curse does to the seekers, so the hider knows what they're casting.
 *
 * The FULL text is unchanged everywhere it matters: the SEEKERS still
 * receive `card.description` verbatim in the curse payload, and the cast
 * dialog's new "Rules" link deep-links to the full rulebook entry. So this
 * only trims the hider's cast-time DISPLAY, never the game data.
 *
 * Summaries keep the `{{km:}}` / `{{m:}}` / size-triplet templates so
 * `renderBodyText` still converts units + collapses S/M/L to the active
 * game size at display time.
 *
 * Any curse NOT in this map falls back to its full description (so a new
 * curse is never silently blanked). An empty string renders no description
 * paragraph at all (the name + casting cost say it).
 */
export const CURSE_CAST_SUMMARY: Record<string, string> = {
    // ── Action curses (the hider does something in the dialog) ──────────
    "Curse of the Mediocre Travel Agent":
        "Choose any publicly-accessible place within {{km:0.5}} (S) / {{km:0.5}} (M) / {{km:1}} (L) of the seekers. They can't currently be on transit.",
    "Curse of the Unguided Tourist":
        "Send the seekers a Street View image from a street within {{m:150}} of them — parallel to the horizon, with a building in shot.",
    "Curse of the Labyrinth":
        "Draw a solvable maze (up to 10 min (S) / 20 min (M) / 30 min (L)) and send a photo of it to the seekers.",
    "Curse of the Zoologist":
        "Take a photo of a wild animal — fish, bird, mammal, reptile, amphibian, or bug.",
    "Curse of the Luxury Car":
        "Take a photo of a car. The seekers must photograph a more expensive one.",
    "Curse of the Bird Guide":
        "Film a bird for as long as you can, up to 5 min (S) / 10 min (M) / 15 min (L).",
    "Curse of the Cairn":
        "Stack a freestanding rock tower, then tell the seekers how many rocks high it stood.",
    "Curse of the Hidden Hangman":
        "Choose a secret 5-letter word. The seekers must beat you at hangman before asking a question or boarding transit.",
    "Curse of the Drained Brain":
        "Choose three questions in different categories. The seekers can't ask them for the rest of your run.",
    "Curse of the Ransom Note":
        "The seekers' next question must be spelled out with letters cut from printed material.",

    // ── Task / timed curses (no dialog action — one-line gist) ──────────
    "Curse of the Distant Cuisine":
        "The seekers must visit a restaurant serving food from a country as far away or farther than the one you name.",
    "Curse of the Jammed Door":
        "For 0.5 h (S) / 1 h (M) / 3 h (L), the seekers must roll 2 dice and get 7+ to pass through any doorway.",
    "Curse of Spotty Memory":
        "For the rest of your run, one random question category is disabled at all times — re-rolled after each question.",
    "Curse of Water Weight":
        "The seekers must acquire and carry 2 L of liquid per seeker for the rest of your run.",
    "Curse of the Egg Partner":
        "The seekers must carry an egg for the rest of your run — if it cracks, you're awarded a time bonus.",
    "Curse of the U-Turn":
        "The seekers must get off their current transit at the next station.",
    "Curse of the Bridge Troll":
        "The seekers must ask their next question from under a bridge.",
    "Curse of the Impressionable Consumer":
        "The seekers must visit a place or buy a product they saw advertised out in the world (not on a device).",
    "Curse of the Endless Tumble":
        "The seekers must roll a die {{m:30}} and land a 5 or 6 before asking another question.",
    "Curse of the Overflowing Chalice":
        "For your next three questions, you may draw one extra card (you don't keep it).",
    "Curse of the Gambler's Feet":
        "For 20 min (S) / 40 min (M) / 60 min (L), the seekers must roll a die before every set of steps.",
    "Curse of the Urban Explorer":
        "For the rest of your run, the seekers can't ask questions while on transit or in a transit station.",
    "Curse of the Lemon Phylactery":
        "Each seeker must carry a lemon on their body — if one drops off, you're awarded a time bonus.",
    "Curse of the Right Turn":
        "For 20 min (S) / 40 min (M) / 60 min (L), the seekers can only turn right at intersections.",
};

/**
 * The text to show for a curse in the CAST dialog: the shortened,
 * hider-facing summary if we have one, else the full description (so a
 * future/unmapped curse still renders something meaningful).
 */
export function curseCastSummary(name: string, fullDescription: string): string {
    const s = CURSE_CAST_SUMMARY[name];
    return s !== undefined ? s : fullDescription;
}

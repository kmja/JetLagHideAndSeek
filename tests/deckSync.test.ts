import { beforeEach, describe, expect, test } from "vitest";

import {
    applySharedDeckState,
    chaliceDrawsRemaining,
    hiderDeck,
    hiderDiscard,
    hiderHand,
    hiderHandLimit,
    pendingDraw,
    pendingDrawQueue,
    readSharedDeckState,
    resetHiderRoundState,
} from "../src/lib/hiderRole";

/**
 * v831 Track 2: the shared hide-team deck syncs as one `DeckStateShare`
 * blob. These lock the read/apply contract that the multiplayer bridge
 * relies on — a full round-trip must preserve every field, and adopting a
 * teammate's state must overwrite the local one wholesale.
 */
describe("shared deck state read/apply", () => {
    beforeEach(() => {
        resetHiderRoundState();
    });

    const card = (id: string) => ({
        kind: "powerup" as const,
        id,
        title: id,
        description: "",
    });

    test("readSharedDeckState snapshots all seven atoms", () => {
        hiderHand.set([card("a")]);
        hiderDeck.set([card("b"), card("c")]);
        hiderDiscard.set([card("d")]);
        hiderHandLimit.set(8);
        chaliceDrawsRemaining.set(2);
        pendingDraw.set({
            cards: [card("e"), card("f")],
            keep: 1,
            sourceCategory: "matching",
            sourceQuestionKey: 42,
        });
        pendingDrawQueue.set([
            {
                cards: [card("g")],
                keep: 1,
                sourceCategory: "photo",
                sourceQuestionKey: 7,
            },
        ]);

        const s = readSharedDeckState();
        expect(s.hand).toHaveLength(1);
        expect(s.deck).toHaveLength(2);
        expect(s.discard).toHaveLength(1);
        expect(s.handLimit).toBe(8);
        expect(s.chalice).toBe(2);
        expect((s.pending as { keep: number }).keep).toBe(1);
        expect(s.pendingQueue).toHaveLength(1);
    });

    test("read → apply is a faithful round-trip", () => {
        hiderHand.set([card("a"), card("b")]);
        hiderDeck.set([card("c")]);
        hiderHandLimit.set(7);
        chaliceDrawsRemaining.set(3);
        const snapshot = readSharedDeckState();

        // Simulate a fresh device (round reset) then adopting the snapshot.
        resetHiderRoundState();
        expect(hiderHand.get()).toHaveLength(0);
        expect(hiderHandLimit.get()).toBe(6);

        applySharedDeckState(snapshot);
        expect(hiderHand.get()).toHaveLength(2);
        expect(hiderDeck.get()).toHaveLength(1);
        expect(hiderHandLimit.get()).toBe(7);
        expect(chaliceDrawsRemaining.get()).toBe(3);
    });

    test("applying null keeps the local (freshly-reset) state", () => {
        hiderHand.set([card("x")]);
        applySharedDeckState(null);
        // null = "no shared deck yet" — must NOT wipe the local hand.
        expect(hiderHand.get()).toHaveLength(1);
    });

    test("apply overwrites the local hand wholesale", () => {
        hiderHand.set([card("local1"), card("local2"), card("local3")]);
        applySharedDeckState({
            hand: [card("shared")],
            deck: [],
            discard: [],
            handLimit: 6,
            chalice: 0,
            pending: null,
            pendingQueue: [],
        });
        expect(hiderHand.get()).toHaveLength(1);
        expect((hiderHand.get()[0] as { id: string }).id).toBe("shared");
    });

    test("apply tolerates a malformed/partial blob", () => {
        hiderHand.set([card("keep")]);
        applySharedDeckState({
            // Missing arrays / wrong types — must degrade to safe defaults.
            hand: undefined as unknown as unknown[],
            deck: null as unknown as unknown[],
            discard: [],
            handLimit: NaN as unknown as number,
            chalice: "x" as unknown as number,
            pending: null,
            pendingQueue: "nope" as unknown as unknown[],
        });
        expect(hiderHand.get()).toEqual([]);
        expect(hiderDeck.get()).toEqual([]);
        expect(hiderHandLimit.get()).toBe(6);
        expect(chaliceDrawsRemaining.get()).toBe(0);
        expect(pendingDrawQueue.get()).toEqual([]);
    });
});

import { createContext } from "react";

/**
 * Context the AddQuestionDialog uses to listen for the configure-dialog
 * picker's readiness (reference lookup settled + impact computed + tiles
 * painted + finite pin). v371: lets the Send button stay disabled until
 * every async piece of the pending question has finished computing,
 * without threading an `onReadyChange` callback through 5 question-card
 * components and 2 picker wrappers.
 *
 * InlineLocationPicker calls `onPickerReady` whenever its combined
 * readiness flips. Pickers mounted OUTSIDE the configure dialog (the
 * in-list display cards, the hider preview) see `null` here and emit
 * nothing — only the configure-dialog instance writes through.
 */
export interface ConfigureDialogContextValue {
    onPickerReady: (ready: boolean) => void;
}

export const ConfigureDialogContext =
    createContext<ConfigureDialogContextValue | null>(null);

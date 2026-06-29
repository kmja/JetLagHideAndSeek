import { useStore } from "@nanostores/react";
import { BookOpen } from "lucide-react";
import { Drawer as VaulDrawer } from "vaul";

import { HouseRulesSection } from "@/components/HouseRulesSection";
import { HowToPlaySheet } from "@/components/HowToPlaySheet";
import { PreloadChoicesPanel } from "@/components/PreloadChoicesPanel";
import { PWAInstallButton } from "@/components/PWAInstallButton";
import { RulebookSheet } from "@/components/RulebookSheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UnitSelect } from "@/components/UnitSelect";
import { defaultUnit } from "@/lib/context";
import { moreSheetOpen, setupCompleted } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Shared "Settings" drawer used by both the seeker BottomNav and
 * the HiderBottomNav. Contents:
 *
 *   • Tutorial (HowToPlaySheet)
 *   • Rulebook (RulebookSheet)
 *   • PWA install
 *   • Units selector
 *   • Theme toggle
 *   • Preload preferences (only after setup is committed)
 *
 * Open state is the shared `moreSheetOpen` atom — flipping it from
 * either nav surfaces the drawer. SeekerPage / HiderPage are
 * mutually exclusive routes, so only one mount is alive at a time.
 *
 * Extracted from BottomNav in v287 to give the hider the same
 * chrome the seeker has.
 */
export function AppSettingsDrawer() {
    const $moreOpen = useStore(moreSheetOpen);
    const $defaultUnit = useStore(defaultUnit);
    const $setupCompleted = useStore(setupCompleted);

    return (
        <VaulDrawer.Root
            open={$moreOpen}
            onOpenChange={(o) => moreSheetOpen.set(o)}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[85vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    <div className="overflow-y-auto px-6 pt-4 pb-6">
                        <div className="space-y-1.5">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                Settings
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-sm text-muted-foreground">
                                Tutorial, rulebook, install, and
                                mid-game preload preferences.
                            </VaulDrawer.Description>
                        </div>
                        <div className="mt-4 space-y-2">
                            <HowToPlaySheet
                                onBeforeOpen={() => moreSheetOpen.set(false)}
                            />
                            <RulebookSheet
                                onBeforeOpen={() => moreSheetOpen.set(false)}
                            >
                                <button
                                    type="button"
                                    className={cn(
                                        "w-full flex items-center justify-center gap-2",
                                        "px-3 py-2 rounded-md",
                                        "bg-secondary hover:bg-accent border border-border",
                                        "text-sm font-semibold text-foreground transition-colors",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                    title="Open the official Hide + Seek rulebook (searchable)"
                                >
                                    <BookOpen className="w-4 h-4" />
                                    Rulebook
                                </button>
                            </RulebookSheet>
                            <PWAInstallButton />

                            <div className="pt-3 mt-3 border-t border-border space-y-3">
                                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                    App
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm font-medium">
                                        Units
                                    </span>
                                    <UnitSelect
                                        unit={$defaultUnit}
                                        onChange={defaultUnit.set}
                                    />
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-sm font-medium">
                                        Theme
                                    </span>
                                    <ThemeToggle />
                                </div>
                            </div>

                            <HouseRulesSection />

                            {$setupCompleted && (
                                <div className="pt-3 mt-3 border-t border-border">
                                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-2">
                                        Preload during hiding
                                    </div>
                                    <PreloadChoicesPanel
                                        runImmediatelyOnEnable
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

export default AppSettingsDrawer;

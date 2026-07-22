import { AppTopBar } from "@/components/AppTopBar";

/**
 * HiderTopBar — brand chrome at the top of the hider viewport. Stays visible
 * at all sizes (no sidebars to carry the brand on desktop). v1120: thin
 * wrapper over the shared `AppTopBar` (v632 parity with SeekerTopBar is now
 * literal, not hand-kept).
 */
export function HiderTopBar() {
    return <AppTopBar className="z-[1041]" />;
}

export default HiderTopBar;

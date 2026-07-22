import { AppTopBar } from "@/components/AppTopBar";

/**
 * SeekerTopBar — fixed-top chrome for the seeker view. Mobile-only
 * (`md:hidden`; desktop has the sidebars) and hidden in fullscreen.
 * v1120: thin wrapper over the shared `AppTopBar`.
 */
export function SeekerTopBar() {
    return (
        <AppTopBar
            hideOnDesktop
            className="z-[1040] group-[.fullscreen]:hidden"
        />
    );
}

export default SeekerTopBar;

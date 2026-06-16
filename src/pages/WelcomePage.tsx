import { Welcome } from "@/components/Welcome";

/**
 * /welcome route. Thin wrapper around the Welcome panel so the
 * seeker / hider shells (sidebars, map, top + bottom nav, lazy
 * drawers) never load on app launch for a fresh user. The route
 * guards in App.tsx redirect unseen users here from `/` and `/h`;
 * Welcome itself reverse-redirects to / or /h once a path is
 * picked.
 */
export function WelcomePage() {
    return <Welcome />;
}

export default WelcomePage;

import {
    createBrowserRouter,
    RouterProvider,
} from "react-router-dom";
import { ToastContainer } from "react-toastify";

import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import { HiderPage } from "@/pages/HiderPage";
import { SeekerPage } from "@/pages/SeekerPage";

// Single React-Router root. The Astro era had two .astro pages
// each compiled to its own HTML shell; the SPA serves a single
// shell and the router picks SeekerPage / HiderPage by pathname.
// SPA fallback to index.html is configured in wrangler.jsonc so
// deep links keep working.
const router = createBrowserRouter([
    { path: "/", element: <SeekerPage /> },
    { path: "/h", element: <HiderPage /> },
    { path: "/h/", element: <HiderPage /> },
    // Catch-all — anything else lands on the seeker shell. Matches
    // the previous Astro behaviour of `not_found_handling:
    // "single-page-application"`.
    { path: "*", element: <SeekerPage /> },
]);

export function App() {
    return (
        <>
            <RouterProvider router={router} />
            {/* Toast portal — single instance shared across both
                routes. Same z-index ladder rules as before
                (toasts sit above dialogs at z-1090). */}
            <ToastContainer
                position="top-center"
                autoClose={5000}
                hideProgressBar={false}
                newestOnTop
                closeOnClick
                pauseOnFocusLoss
                draggable={false}
                pauseOnHover
                theme="dark"
            />
            <PWAUpdatePrompt />
        </>
    );
}

export default App;

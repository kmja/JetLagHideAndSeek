import { useStore } from "@nanostores/react";
import { useEffect, useRef, useState } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RawInput } from "@/components/ui/input";
import { pendingPrompt } from "@/lib/confirm";

/**
 * App-styled replacement for `window.prompt()` — mounted once at the
 * page root next to `AppConfirmHost`. Renders an AlertDialog with a
 * single text input. Enter submits, Esc / Cancel / overlay-click
 * resolves with `null`. Mirrors `AppConfirmHost`'s atom-driven API so
 * call sites use `await appPrompt(...)` from anywhere in the tree.
 */
export function AppPromptHost() {
    const $pending = useStore(pendingPrompt);
    const open = $pending !== null;
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if ($pending) {
            setValue($pending.defaultValue ?? "");
            // Defer to next tick so the input is mounted before
            // focusing — autoFocus on RawInput would also work but
            // the explicit ref-then-select pattern reproduces the
            // native prompt() ergonomic of "type starts replacing
            // the default text immediately."
            requestAnimationFrame(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            });
        }
    }, [$pending]);

    const resolve = (value: string | null) => {
        if ($pending) $pending.resolve(value);
        pendingPrompt.set(null);
    };

    return (
        <AlertDialog
            open={open}
            onOpenChange={(next) => {
                if (!next) resolve(null);
            }}
        >
            <AlertDialogContent
                className="z-[1300]"
                overlayClassName="z-[1295]"
            >
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {$pending?.title ?? ""}
                    </AlertDialogTitle>
                    {$pending?.description && (
                        <AlertDialogDescription>
                            {$pending.description}
                        </AlertDialogDescription>
                    )}
                </AlertDialogHeader>
                <RawInput
                    ref={inputRef}
                    value={value}
                    placeholder={$pending?.placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            resolve(value);
                        }
                    }}
                />
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => resolve(null)}>
                        {$pending?.cancelLabel ?? "Cancel"}
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={() => resolve(value)}>
                        {$pending?.confirmLabel ?? "OK"}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

export default AppPromptHost;

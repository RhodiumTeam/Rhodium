// The toasts up (spec web-write), apart from what draws them: the board's first screen knows whether
// one is up, as after an archive in a chat it went back from, without the code that writes.
import { useSyncExternalStore } from "react";
import type { BoardAct } from "../../src/contracts";

/** How long a toast with 撤销, or an error, stays (stories 268, 316, 543). */
const LONG_MS = 8000;

/** at: when it showed. undo: what 撤销 sends. */
export type Toast = { id: number; text: string; error: boolean; undo?: BoardAct; at: number };
let toasts: Toast[] = [];
let last = 0;
const listeners = new Set<() => void>();
const set = (next: Toast[]) => ((toasts = next), listeners.forEach((f) => f()));
export const dismiss = (id: number) => set(toasts.filter((t) => t.id !== id));

/** Shows text in a toast (story 256): one that went well goes after 3 s; an error after 8 s (story 543).
 *  With undo, it has 撤销 for 8 s, which sends undo (story 268). */
export function toast(text: string, error = false, undo?: BoardAct): void {
  const id = ++last;
  set([...toasts, { id, text, error, undo, at: Date.now() }]);
  setTimeout(() => dismiss(id), undo || error ? LONG_MS : 3000);
}

/** The toasts up, oldest first. */
export const useToasts = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => toasts,
    () => toasts,
  );

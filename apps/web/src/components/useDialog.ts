import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls in `root` that Tab can reach, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null));
}

/** Open dialogs, the newest last: only the newest answers Escape and keeps the focus. */
const stack: HTMLElement[] = [];

/**
 * Keyboard and screen-reader behaviour of a dialog (WCAG 2.4.3, WP 6.2): when it opens the focus
 * moves into it (to an [autofocus] or [data-autofocus] control, else the first control); in a
 * modal one Tab and Shift+Tab stay inside; Escape closes it; when it closes the focus goes back to
 * the control that had it before, so a keyboard user carries on where they were.
 *
 * Attach the returned ref to the element with role="dialog".
 */
export function useDialog<T extends HTMLElement>(open: boolean, o: { modal?: boolean; onClose?: () => void } = {}) {
  const ref = useRef<T>(null);
  const onClose = useRef(o.onClose);
  onClose.current = o.onClose;
  const modal = o.modal ?? true;

  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // React's own autoFocus has run by now (at commit). Not in an animation frame: while the 3D
    // view is busy a frame can take seconds.
    if (!root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(root)[0] ?? root;
      if (first === root && !root.hasAttribute("tabindex")) root.tabIndex = -1;
      first.focus();
    }
    stack.push(root);
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== root) return;
      if (e.key === "Escape" && onClose.current) {
        // A non-modal one (a menu) closes only while the focus is in it.
        if (e.defaultPrevented || (!modal && !root.contains(document.activeElement))) return;
        e.preventDefault();
        e.stopPropagation();
        onClose.current();
        return;
      }
      if (e.key !== "Tab" || !modal) return;
      const all = focusables(root);
      if (!all.length) return e.preventDefault();
      const first = all[0]!;
      const last = all[all.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !root.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !root.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(root), 1);
      const at = document.activeElement;
      if (opener?.isConnected && (!at || at === document.body || !at.isConnected || root.contains(at))) opener.focus({ preventScroll: true });
    };
  }, [open, modal]);

  return ref;
}

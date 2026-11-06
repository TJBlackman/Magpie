import { useEffect, useRef, type KeyboardEvent } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * For a dialog (the quality sheet, Settings): focus moves into it when it
 * opens, Tab and Shift+Tab cycle inside it, and focus goes back to where it
 * was when it closes. Spread the result on the dialog element.
 */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const list = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return { ref, tabIndex: -1, onKeyDown };
}

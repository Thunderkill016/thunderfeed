"use client";

import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog shell — WAI-ARIA modal pattern: focus moves in on open,
 * Tab cycles inside, scroll locks, focus restores on close. Escape is
 * handled by the parent (Edition) so it can coordinate layered overlays.
 */
export default function Modal({
  onClose,
  label,
  children,
}: {
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>(".modal-close")?.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !ref.current) return;
      const els = [
        ...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ].filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      document.body.style.overflow = prevOverflow;
      prev?.focus();
    };
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={ref}
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <button className="modal-close" onClick={onClose} aria-label="Đóng">
          ×
        </button>
        {children}
      </div>
    </div>
  );
}

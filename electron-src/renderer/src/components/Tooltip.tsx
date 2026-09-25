import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function tooltipProps(text: string) {
  return { "data-tip": text } as const;
}

export function Tooltip({ text, align = "start", children }: {
  text: string;
  align?: "start" | "center";
  children: ReactNode;
}) {
  return <span className={`tooltip-trigger tooltip-trigger--${align}`} data-tip={text}>{children}</span>;
}

interface TooltipTarget {
  source: HTMLElement;
  anchor: HTMLElement;
}

function findTooltipTarget(target: EventTarget | null): TooltipTarget | null {
  if (!(target instanceof Element)) return null;
  const isControl = target instanceof HTMLInputElement || target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement;
  const source = target.closest<HTMLElement>("[data-tip]") ?? (isControl
    ? Array.from(target.labels ?? []).find((label) => label.dataset.tip)
    : null);
  if (!source?.dataset.tip?.trim()) return null;
  return { source, anchor: isControl ? target : source };
}

/** One tooltip layer for every renderer control, including disabled inputs and dialogs. */
export function TooltipLayer() {
  const id = `gsm-tooltip-${useId()}`;
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<(TooltipTarget & { text: string }) | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    let hovered: TooltipTarget | null = null;
    let focused: TooltipTarget | null = null;
    let dismissed: HTMLElement | null = null;

    const update = () => {
      if (!hovered?.anchor.isConnected || !hovered.source.isConnected) hovered = null;
      if (!focused?.anchor.isConnected || !focused.source.isConnected) focused = null;
      const target = hovered ?? focused;
      const text = target?.source.dataset.tip;
      setActive((current) => {
        if (!target || !text?.trim() || target.source === dismissed) return null;
        if (current?.source === target.source && current.anchor === target.anchor && current.text === text) {
          return current;
        }
        return { ...target, text };
      });
    };
    const hover = (target: EventTarget | null) => {
      const next = findTooltipTarget(target);
      if (next?.source !== hovered?.source) dismissed = null;
      hovered = next;
      update();
    };
    const onPointerOver = (event: PointerEvent) => hover(event.target);
    const onPointerOut = (event: PointerEvent) => hover(event.relatedTarget);
    const onFocusIn = (event: FocusEvent) => {
      focused = findTooltipTarget(event.target);
      hovered = null;
      dismissed = null;
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      focused = findTooltipTarget(event.relatedTarget);
      update();
    };
    const dismiss = () => {
      dismissed = (hovered ?? focused)?.source ?? null;
      setActive(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onBlur = () => {
      hovered = null;
      focused = null;
      update();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", onBlur);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tip"] });
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useLayoutEffect(() => {
    if (!active || !tooltipRef.current) return;
    const anchor = active.anchor.getBoundingClientRect();
    const tooltip = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const centered = active.source.classList.contains("tooltip-trigger--center");
    const left = centered ? anchor.left + (anchor.width - tooltip.width) / 2 : anchor.left;
    const top = anchor.bottom + gap + tooltip.height > window.innerHeight - margin
      ? anchor.top - tooltip.height - gap
      : anchor.bottom + gap;
    setPosition({
      left: Math.max(margin, Math.min(left, window.innerWidth - tooltip.width - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - tooltip.height - margin))
    });

    const descriptions = (active.anchor.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    active.anchor.setAttribute("aria-describedby", [...new Set([...descriptions, id])].join(" "));
    return () => {
      const remaining = (active.anchor.getAttribute("aria-describedby") ?? "").split(/\s+/)
        .filter((description) => description && description !== id);
      if (remaining.length) active.anchor.setAttribute("aria-describedby", remaining.join(" "));
      else active.anchor.removeAttribute("aria-describedby");
    };
  }, [active, id]);

  return active ? createPortal(
    <div id={id} ref={tooltipRef} role="tooltip" className="app-tooltip" style={position}>{active.text}</div>,
    document.body
  ) : null;
}

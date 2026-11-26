import { useEffect, useMemo, useRef } from "react";
import { OcrAreaSelector, type InlineSelectorHost, type SelectorArea } from "../OcrAreaSelector";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";
import type { OcrPreviewFrame } from "../../../../shared/ocr_preview";
import type { OcrAreaConfig } from "../../../../shared/ocr_areas";

type Layout = { rects: SelectorArea[]; help: boolean; revision: string };
type Saved = { config: OcrAreaConfig; revision: string };
type LayoutError = { error: "sceneChanged" | "conflict" };

export function InlineAreaSelector({ docked = false, active = true, initial, preview, refresh, onSaved, onClose, autoRefresh, onAutoRefreshChange, onFeedTarget }: {
  docked?: boolean;
  active?: boolean;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onFeedTarget?: (target: HTMLDivElement | null) => void;
  initial: OcrPreviewFrame;
  preview: OcrPreviewFrame;
  refresh: () => void;
  onSaved?: (config: OcrAreaConfig) => void;
  onClose: (saved: boolean) => void;
}) {
  const t = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    element?.showModal();
    return () => { mounted.current = false; element?.close(); };
  }, []);

  useEffect(() => {
    if (active) workspace.current?.focus({preventScroll: true});
  }, [active]);

  const host = useMemo<InlineSelectorHost>(() => {
    const target = {sceneId: initial.sceneId, sceneName: initial.sceneName, sourceName: initial.sourceName,
      size: initial.sourceSize ?? [initial.width, initial.height]};
    let revision: string;
    let savedAreas: SelectorArea[] | undefined;
    let pending = Promise.resolve();
    return {
      async load() {
        const layout = await invokeIpc<Layout | LayoutError>("ocr.preview-layout", target);
        if ("error" in layout) throw new Error(t("ocr.desk.editor.errors." + layout.error));
        revision = layout.revision;
        return {help: layout.help, capture: {rects: layout.rects, image: initial.imageData,
          width: target.size[0], height: target.size[1]}};
      },
      save(rects) {
        // Auto-Send and the final Save share the last acknowledged revision.
        const write = pending.then(async () => {
          if (!mounted.current || savedAreas === rects) return;
          const saved = await invokeIpc<Saved | LayoutError>("ocr.apply-preview-layout", {...target, revision, rects});
          if ("error" in saved) throw new Error(t("ocr.desk.editor.errors." + saved.error));
          revision = saved.revision;
          savedAreas = rects;
          if (mounted.current) onSaved?.(saved.config);
        });
        pending = write.catch(() => {});
        return write;
      },
      close: onClose, refresh
    };
  }, [initial, refresh, onClose, onSaved, t]);

  const tools = <OcrAreaSelector active={active} host={host} preview={preview} autoRefresh={autoRefresh} onAutoRefreshChange={onAutoRefreshChange} />;
  const title = t("nativeDialogs.area.title");
  if (docked) return (
    <section className="ocr-selector-workspace" ref={workspace} tabIndex={-1} hidden={!active} aria-label={title}>
      {tools}
      {onFeedTarget && <div className="ocr-selector-feed" ref={onFeedTarget} />}
    </section>
  );
  return <dialog className="ocr-selector-dialog" ref={dialog} aria-label={title} onCancel={event => event.preventDefault()}>
    {tools}
  </dialog>;
}

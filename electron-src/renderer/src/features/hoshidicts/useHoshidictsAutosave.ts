import { useCallback, useEffect, useRef, useState } from "react";

import type { HoshidictsActionResult } from "../../../../shared/features/hoshidicts";
import { invokeIpc } from "../../lib/ipc";
import type { SaveStatus } from "./hoshidictsSettingsModel";

const AUTO_SAVE_DELAY_MS = 400;

interface HoshidictsAutosaveOptions<TDraft, TRequest> {
  initialDraft: () => TDraft;
  cloneDraft: (draft: TDraft) => TDraft;
  toRequest: (draft: TDraft) => TRequest;
  savedDraft: (result: HoshidictsActionResult, request: TRequest) => TDraft;
  channel: string;
  errorFallback: string;
  applyResult: (result: HoshidictsActionResult, showOutcome?: boolean) => boolean;
  setActionError: (message: string | null) => void;
  paused?: boolean;
}

export function useHoshidictsAutosave<TDraft, TRequest>({
  initialDraft,
  cloneDraft,
  toRequest,
  savedDraft,
  channel,
  errorFallback,
  applyResult,
  setActionError,
  paused = false
}: HoshidictsAutosaveOptions<TDraft, TRequest>) {
  const [draft, setDraft] = useState<TDraft>(() => initialDraft());
  const draftRef = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const editVersionRef = useRef(0);
  const blockedVersionRef = useRef(-1);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  const updateDraft = useCallback(
    (update: (current: TDraft) => TDraft) => {
      const next = update(cloneDraft(draftRef.current));
      draftRef.current = next;
      editVersionRef.current += 1;
      dirtyRef.current = true;
      setDraft(next);
      setDirty(true);
      setSaveStatus("dirty");
      setActionError(null);
    },
    [cloneDraft, setActionError]
  );

  const syncDraft = useCallback(
    (nextDraft: TDraft, force = false) => {
      if (!force && (dirtyRef.current || savingRef.current)) return;
      const next = cloneDraft(nextDraft);
      draftRef.current = next;
      setDraft(next);
    },
    [cloneDraft]
  );

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (inFlightRef.current) return await inFlightRef.current;
    if (!dirtyRef.current) return true;
    if (
      paused ||
      blockedVersionRef.current === editVersionRef.current
    ) {
      return false;
    }

    const request = toRequest(cloneDraft(draftRef.current));
    const version = editVersionRef.current;
    savingRef.current = true;
    setSaving(true);
    setSaveStatus("saving");
    const save = invokeIpc<HoshidictsActionResult>(channel, request)
      .then((result) => {
        const success = applyResult(result, false);
        if (!success) {
          blockedVersionRef.current = version;
          setSaveStatus("error");
          return false;
        }
        if (editVersionRef.current === version) {
          dirtyRef.current = false;
          setDirty(false);
          const next = cloneDraft(savedDraft(result, request));
          draftRef.current = next;
          setDraft(next);
          setSaveStatus("saved");
        } else {
          setSaveStatus("dirty");
        }
        return true;
      })
      .catch((error) => {
        blockedVersionRef.current = version;
        setActionError(
          error instanceof Error && error.message ? error.message : errorFallback
        );
        setSaveStatus("error");
        return false;
      })
      .finally(() => {
        savingRef.current = false;
        setSaving(false);
        inFlightRef.current = null;
      });
    inFlightRef.current = save;
    return await save;
  }, [
    applyResult,
    channel,
    cloneDraft,
    errorFallback,
    paused,
    savedDraft,
    setActionError,
    toRequest
  ]);

  const flush = useCallback(async (): Promise<boolean> => {
    while (inFlightRef.current || dirtyRef.current) {
      const success = inFlightRef.current
        ? await inFlightRef.current
        : await saveNow();
      if (!success) return false;
    }
    return true;
  }, [saveNow]);

  useEffect(() => {
    if (
      !dirty ||
      saving ||
      paused ||
      blockedVersionRef.current === editVersionRef.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void saveNow();
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, paused, saveNow, saving]);

  return {
    draft,
    draftRef,
    saving,
    saveStatus,
    updateDraft,
    syncDraft,
    flush
  };
}

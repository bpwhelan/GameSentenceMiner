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
}

export function useHoshidictsAutosave<TDraft, TRequest>({
  initialDraft,
  cloneDraft,
  toRequest,
  savedDraft,
  channel,
  errorFallback,
  applyResult,
  setActionError
}: HoshidictsAutosaveOptions<TDraft, TRequest>) {
  const [draft, setDraft] = useState<TDraft>(() => initialDraft());
  const draftRef = useRef(draft);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const editVersionRef = useRef(0);
  const blockedVersionRef = useRef(-1);
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

  useEffect(() => {
    if (
      !dirty ||
      saving ||
      blockedVersionRef.current === editVersionRef.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const request = toRequest(cloneDraft(draftRef.current));
      const version = editVersionRef.current;
      savingRef.current = true;
      setSaving(true);
      setSaveStatus("saving");
      void invokeIpc<HoshidictsActionResult>(channel, request)
        .then((result) => {
          const success = applyResult(result, false);
          if (!success) {
            blockedVersionRef.current = version;
            setSaveStatus("error");
          } else if (editVersionRef.current === version) {
            dirtyRef.current = false;
            setDirty(false);
            const next = cloneDraft(savedDraft(result, request));
            draftRef.current = next;
            setDraft(next);
            setSaveStatus("saved");
          } else {
            setSaveStatus("dirty");
          }
        })
        .catch((error) => {
          blockedVersionRef.current = version;
          setActionError(
            error instanceof Error && error.message ? error.message : errorFallback
          );
          setSaveStatus("error");
        })
        .finally(() => {
          savingRef.current = false;
          setSaving(false);
        });
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    applyResult,
    channel,
    cloneDraft,
    dirty,
    draft,
    errorFallback,
    savedDraft,
    saving,
    setActionError,
    toRequest
  ]);

  return { draft, draftRef, saving, saveStatus, updateDraft, syncDraft };
}

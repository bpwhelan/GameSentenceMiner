import type { ReactNode } from "react";
import { AgentScriptDisplay } from "./AgentScriptDisplay";
import {
  filterAgentScriptCandidatesForQuery,
  normalizeAgentScriptPathForCompare,
  type AgentScriptCandidate,
} from "../../../shared/agent_scripts";

type AgentScriptSearchTitle =
  | ReactNode
  | ((filteredCount: number, totalCount: number) => ReactNode);

interface AgentScriptSearchDialogProps {
  candidates: AgentScriptCandidate[];
  query: string;
  title: AgentScriptSearchTitle;
  titleTooltip?: string;
  closeLabel: string;
  closeTitle?: string;
  searchPlaceholder: string;
  noResultsLabel: string;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelect: (scriptPath: string) => void;
  getCandidateMeta?: (candidate: AgentScriptCandidate, index: number) => ReactNode;
  getCandidateTitle?: (candidate: AgentScriptCandidate, index: number) => string;
  selectedPath?: string;
}

export function AgentScriptSearchDialog({
  candidates,
  query,
  title,
  titleTooltip,
  closeLabel,
  closeTitle,
  searchPlaceholder,
  noResultsLabel,
  onClose,
  onQueryChange,
  onSelect,
  getCandidateMeta,
  getCandidateTitle,
  selectedPath = "",
}: AgentScriptSearchDialogProps) {
  const filteredCandidates = filterAgentScriptCandidatesForQuery(candidates, query);
  const normalizedSelectedPath = selectedPath
    ? normalizeAgentScriptPathForCompare(selectedPath)
    : "";
  const renderedTitle =
    typeof title === "function"
      ? title(filteredCandidates.length, candidates.length)
      : title;

  return (
    <div className="launcher-config-modal agent-script-search-dialog" role="dialog" aria-modal="true">
      <div className="launcher-config-modal-header">
        <strong title={titleTooltip}>{renderedTitle}</strong>
        <button type="button" className="secondary" title={closeTitle} onClick={onClose}>
          {closeLabel}
        </button>
      </div>
      <div className="launcher-script-search-row">
        <input
          type="search"
          className="launcher-script-search-input"
          value={query}
          placeholder={searchPlaceholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </div>
      <div className="launcher-script-picker">
        {filteredCandidates.length === 0 ? (
          <p className="muted agent-script-search-dialog__empty">{noResultsLabel}</p>
        ) : null}
        {filteredCandidates.map((candidate, index) => {
          const selected =
            normalizedSelectedPath.length > 0 &&
            normalizeAgentScriptPathForCompare(candidate.path) === normalizedSelectedPath;
          return (
            <button
              key={`${candidate.path}-${index}`}
              type="button"
              className={`launcher-script-option agent-script-search-option ${
                selected ? "agent-script-search-option--selected" : ""
              }`}
              title={getCandidateTitle?.(candidate, index) ?? candidate.path}
              aria-pressed={selected}
              onClick={() => onSelect(candidate.path)}
            >
              <span className="agent-script-search-option__display">
                <AgentScriptDisplay
                  scriptPath={candidate.path}
                  meta={getCandidateMeta?.(candidate, index)}
                />
              </span>
              <span className="agent-script-search-option__marker" aria-hidden="true">
                {selected ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default AgentScriptSearchDialog;

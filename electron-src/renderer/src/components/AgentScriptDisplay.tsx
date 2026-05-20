import type { ReactNode } from "react";
import { formatAgentScriptDisplay } from "../../../shared/agent_scripts";

interface AgentScriptDisplayProps {
  scriptPath: string;
  meta?: ReactNode;
  showPath?: boolean;
}

export function AgentScriptDisplay({
  scriptPath,
  meta,
  showPath = true,
}: AgentScriptDisplayProps) {
  const display = formatAgentScriptDisplay(scriptPath);
  const hasMetadata = display.metadata.length > 0;
  const hasMeta = meta !== undefined && meta !== null && meta !== "";

  return (
    <>
      <span className="agent-script-display__title">{display.title}</span>
      {hasMetadata || hasMeta ? (
        <span className="agent-script-display__meta">
          {hasMetadata ? display.metadata : null}
          {hasMetadata && hasMeta ? " | " : null}
          {hasMeta ? meta : null}
        </span>
      ) : null}
      {showPath ? (
        <span className="agent-script-display__path mono-text">{scriptPath}</span>
      ) : null}
    </>
  );
}

import { useEffect, useState, type ReactNode } from 'react';

/** Allocate a tool's controls on first use, then preserve its edits across tabs. */
export function DeferredPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active);
  useEffect(() => { if (active) setOpened(true); }, [active]);
  return opened || active ? children : null;
}

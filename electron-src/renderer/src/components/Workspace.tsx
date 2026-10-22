import type { KeyboardEvent } from "react";
import "./Workspace.css";

export function WorkspaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-5h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3 3-3Z",
    general: "M4 4h16v12H4V4Zm4 16h8M12 16v4",
    layout: "M4 4h16v16H4V4Zm5 0v16M9 10h11",
    updates: "M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3",
    backups: "M4 6h16v14H4V6Zm2-3h12M9 10h6M12 10v6m-3-3 3 3 3-3",
    storage: "M3 6h7l2 2h9v12H3V6Z",
    speech: "M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V4Zm-4 6v1a7 7 0 0 0 14 0v-1M12 18v4m-4 0h8",
    capture: "M4 9v6m4-10v14m4-17v20m4-17v14m4-10v6",
    advanced: "M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M10 14v6",
    activity: "m5 6 5 5-5 5m8 0h6",
    search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
    arrow: "M4 12h16m-6-6 6 6-6 6",
    play: "m8 4 12 8-12 8V4Z",
    stop: "M6 6h12v12H6z",
    check: "m5 12 4 4L19 6",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.general} />
    </svg>
  );
}

export interface WorkspaceNavigationItem<T extends string> {
  id: T;
  label: string;
  icon?: string;
}

export function WorkspaceNavigation<T extends string>({
  prefix,
  items,
  value,
  onChange,
  label,
}: {
  prefix: string;
  items: readonly WorkspaceNavigationItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
}) {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    onChange(items[next].id);
    document.getElementById(prefix + "-nav-" + items[next].id)?.focus();
  };
  return (
    <nav
      className="ws-navigation"
      role="tablist"
      aria-orientation="vertical"
      aria-label={label}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={prefix + "-nav-" + item.id}
          aria-selected={value === item.id}
          aria-controls={prefix + "-view-" + item.id}
          tabIndex={value === item.id || (value === null && index === 0) ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => navigate(event, index)}
        >
          <WorkspaceIcon name={item.icon ?? item.id} />
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

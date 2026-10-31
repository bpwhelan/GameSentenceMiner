function Cobweb({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 96 72" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round">
        <path d="M0 0h95M0 0l90 22M0 0l72 45M0 0l44 64M0 0l17 71M0 0v72" />
        <path d="M22 0q-3 3-2 5-5 0-5 5-6-1-6 4-5-2-6 2-2-1-3 0M45 0q-6 6-3 10-8 0-9 10-9-2-13 9-9-4-12 5-4-3-8 0M69 0q-8 10-4 16-13 1-14 16-14-4-19 14-14-6-19 9-7-4-13 0M94 0q-11 13-7 21-17 1-18 22-19-5-27 18-18-7-24 11" />
      </g>
    </svg>
  );
}

/** Small, static details in the app's corners, with no effect on layout or input. */
export function SeasonalDecorations() {
  return (
    <div className="seasonal-cobwebs" aria-hidden="true" inert>
      <Cobweb className="seasonal-cobweb seasonal-cobweb--top" />
      <Cobweb className="seasonal-cobweb seasonal-cobweb--bottom" />
    </div>
  );
}

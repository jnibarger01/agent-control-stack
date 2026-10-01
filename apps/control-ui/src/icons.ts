/** Small local SVG vocabulary: no external assets, fonts, scripts, or icon dependency. */
export function icon(name: string): string {
  const paths: Record<string, string> = {
    overview: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',
    queue: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h8M8 17h5"/>',
    execution: '<path d="m8 4 12 8-12 8z"/>',
    approvals: '<path d="m12 3 9 9-9 9-9-9z"/><path d="m8 12 3 3 5-6"/>',
    agents:
      '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="15" r="2"/><circle cx="19" cy="15" r="2"/><path d="M7 21v-2a5 5 0 0 1 10 0v2M3 11l4-3M21 11l-4-3"/>',
    executors: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m7 9 5 3 5-3M12 12v6"/>',
    connectors:
      '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m8 8 8 8M13 6h8M18 3v6M3 18h8M6 15v6"/>',
    metrics: '<path d="M4 21V3M4 21h17M8 17v-6M13 17V6M18 17v-9"/>',
    audit: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h8M8 19h4"/>',
    policy: '<path d="m12 3 9 4v5c0 5-9 9-9 9s-9-4-9-9V7z"/><path d="m8 12 3 3 5-6"/>',
    system:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
    alert: '<path d="m12 3 10 18H2z"/><path d="M12 9v5M12 17h.01"/>',
    trend: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>'
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.trend}</svg>`;
}

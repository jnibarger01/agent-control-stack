import { escapeHtml } from "./html.js";

export function pill(value: string): string {
  return `<span class="pill ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

export function time(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : date.toLocaleString();
}

export function nanoToIso(value: string): string {
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? new Date(Math.floor(asNumber / 1_000_000)).toISOString() : value;
}

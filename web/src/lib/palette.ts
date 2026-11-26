/**
 * Validated reference palette (dataviz skill): categorical hues in FIXED
 * order (never cycled), one sequential hue (blue), a diverging pair, and a
 * reserved status set. Dark values are the same hues stepped for #1a1a19.
 */
import { useSyncExternalStore } from 'react';

// Charts use ONE two-colour ramp (Eduport orange -> deep indigo) instead of many bright hues (2026-11-13): series i of n sits at i/(n-1)
// on the ramp, so a 2-line chart is orange + indigo and a 10-row bar chart steps evenly between them.
export const RAMP_LIGHT: [string, string] = ['#f04e23', '#312e81'];
export const RAMP_DARK: [string, string] = ['#ff7a50', '#a5b4fc'];
const hex = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
/** n colours evenly spaced on the two-colour ramp */
export function ramp(n: number, dark = false): string[] {
  const [a, b] = (dark ? RAMP_DARK : RAMP_LIGHT).map(hex);
  return Array.from({ length: Math.max(1, n) }, (_, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    return `#${a.map((v, k) => Math.round(v + (b[k] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  });
}
export const SERIES_LIGHT = ramp(8);
export const SERIES_DARK = ramp(8, true);
export const SEQ = ['#fde8e1', '#fbd6c9', '#f9c2ae', '#f7ae93', '#f59a78', '#f3865e', '#f27246', '#f04e23', '#d9461f', '#c23e1b', '#ab3617', '#942f14', '#7d2710'];
export const DIVERGING = { neg: '#2563eb', mid_light: '#f1f2f5', mid_dark: '#3a3d4c', pos: '#f04e23' };
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };
export const INK = { light: { primary: '#0f172a', secondary: '#475569', muted: '#64748b', grid: '#e2e8f0', axis: '#cbd5e1' }, dark: { primary: '#f6f6fc', secondary: '#bec1d8', muted: '#8488a5', grid: '#32344c', axis: '#454866' } };

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  const mo = new MutationObserver(() => cb());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => { listeners.delete(cb); mo.disconnect(); };
}
const isDark = () => document.documentElement.classList.contains('dark');

export function useTheme() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  const toggle = () => {
    const next = !isDark();
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('lt-theme', next ? 'dark' : 'light'); } catch { /* ignore */ }
    listeners.forEach((l) => l());
  };
  return { dark, toggle, series: dark ? SERIES_DARK : SERIES_LIGHT, ramp: (n: number) => ramp(n, dark), ink: dark ? INK.dark : INK.light, midpoint: dark ? DIVERGING.mid_dark : DIVERGING.mid_light };
}

/** sequential color for 0..1 on the same orange -> indigo gradient as the charts (light tint -> orange -> indigo) */
export function seqColor(t: number, dark = false): string {
  if (Number.isNaN(t)) return dark ? '#2c2c2a' : '#f0efec';
  void SEQ;
  const steps = 13;
  const i = Math.max(0, Math.min(steps - 1, Math.round(t * (steps - 1))));
  const tint = ramp(2, dark)[0];
  const light = dark ? '#3a2a24' : '#fde8e1';
  const half = Math.floor(steps / 2);
  if (i <= half) { const [a, b] = [light, tint].map(hex); const u = i / half; return `#${a.map((v, k) => Math.round(v + (b[k] - v) * u).toString(16).padStart(2, '0')).join('')}`; }
  return ramp(steps - half, dark)[i - half];
}
/** text color that is legible on a sequential step */
export const seqInk = (t: number) => (t > 0.4 ? '#ffffff' : '#0b0b0b');

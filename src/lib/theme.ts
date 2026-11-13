import { useSyncExternalStore } from 'react';

export const THEMES = [
  { id: 'carbon', name: 'Carbono', swatch: ['#0e0f12', '#ff7a2f'] },
  { id: 'ocean', name: 'Oceano', swatch: ['#07111f', '#22d3ee'] },
  { id: 'forest', name: 'Floresta', swatch: ['#08110c', '#a3e635'] },
  { id: 'amethyst', name: 'Ametista', swatch: ['#100b18', '#c084fc'] },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

const KEY = 'ecotire:theme';
const listeners = new Set<() => void>();

function read(): ThemeId {
  try {
    const v = localStorage.getItem(KEY);
    if (THEMES.some((t) => t.id === v)) return v as ThemeId;
  } catch {
    /* ignora */
  }
  return 'carbon';
}

let current: ThemeId = read();
document.documentElement.dataset.theme = current;

export function setTheme(id: ThemeId) {
  current = id;
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignora */
  }
  listeners.forEach((l) => l());
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

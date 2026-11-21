// What the keyboard calls things: ⌘ and ⇧ on a Mac, Ctrl and Shift elsewhere. The shortcuts themselves
// already accept either key (App.tsx keys); this only changes what hints and tooltips show.
export const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const mod = MAC ? '⌘' : 'Ctrl+';
export const REDO = MAC ? '⇧⌘Z' : 'Ctrl+Shift+Z';

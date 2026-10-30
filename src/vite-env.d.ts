/// <reference types="vite/client" />

// Build stamp injected by Vite's `define` (see vite.config.ts): YYYYMMDDHHMM
// in UTC-3. Use the BUILD export from config.ts, which guards against it being
// undefined (e.g. under plain ts-node / vitest).
declare const __BUILD__: string;

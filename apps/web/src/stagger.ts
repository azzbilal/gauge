import type { CSSProperties } from 'react';

/** Row position in a `.stagger` list, consumed by the CSS as --i. */
export const staggerAt = (index: number) => ({ '--i': index }) as CSSProperties;

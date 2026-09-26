export interface GameFinish {
  actions: Record<string, unknown>;
  clientElapsedMs: number;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Next animation frame after the DOM has been updated (for fair timing). */
export const nextPaint = () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame((t) => r(t))));

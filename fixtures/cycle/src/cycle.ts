export function cycleA(depth: number): number {
  if (depth <= 0) return 0;
  return cycleB(depth - 1);
}

export function cycleB(depth: number): number {
  if (depth <= 0) return 0;
  return cycleC(depth - 1);
}

export function cycleC(depth: number): number {
  if (depth <= 0) return 0;
  return cycleA(depth - 1);
}

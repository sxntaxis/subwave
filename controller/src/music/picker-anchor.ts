export function poolAnchor<T>(explicit: T | null | undefined, live: T | null | undefined): T | null {
  return explicit !== undefined ? explicit : live ?? null;
}

// Home Screen icon badge (iOS 16.4+ installed web apps). Best effort: unsupported or denied is fine.
export function setBadge(n: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    const p = n > 0 ? nav.setAppBadge?.(Math.min(n, 99)) : nav.clearAppBadge?.();
    p?.catch(() => {});
  } catch {
    /* not supported */
  }
}

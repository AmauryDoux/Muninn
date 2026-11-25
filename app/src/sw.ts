/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

// App shell only. API responses are never cached (they hold private data).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data: { title?: string; body?: string; url?: string; tag?: string; badge?: number } = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  const nav = self.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  const badge =
    typeof data.badge === "number" && nav.setAppBadge
      ? (data.badge > 0 ? nav.setAppBadge(Math.min(data.badge, 99)) : nav.clearAppBadge?.())?.catch(() => {})
      : undefined;
  event.waitUntil(
    Promise.all([badge, self.registration.showNotification(data.title ?? "Muninn", {
      body: data.body ?? "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: data.url ?? "/" },
    })]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only same-origin paths, so a crafted payload can't open another site.
  const raw = (event.notification.data as { url?: string })?.url ?? "/";
  const url = new URL(raw, self.location.origin);
  const target = url.origin === self.location.origin ? url.href : self.location.origin + "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if (c.url.startsWith(self.location.origin)) {
          await c.focus();
          return (c as WindowClient).navigate(target);
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});

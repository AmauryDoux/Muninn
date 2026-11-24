// Renders the app icons and the iPhone launch screen from the SVGs in app/public/icons.
// Run after changing the art: node scripts/render-icons.mjs (uses Playwright's Chromium).
import { createRequire } from "node:module";
// require() so a globally installed Playwright (NODE_PATH) works too.
const { chromium } = createRequire(import.meta.url)("playwright");
import { readFileSync } from "node:fs";

const full = readFileSync("app/public/icons/raven-full.svg", "utf8");
const svgAt = (size) => full.replace("<svg ", `<svg width="${size}" height="${size}" `);

// [file, size, padding fraction]. iOS masks corners itself, so apple-touch icons are full-bleed squares.
const icons = [
  ["apple-touch-icon.png", 180, 0],
  ["apple-touch-icon-167.png", 167, 0],
  ["apple-touch-icon-152.png", 152, 0],
  ["apple-touch-icon-120.png", 120, 0],
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-1024.png", 1024, 0],
  // Maskable: Android may crop to a circle, so the art sits inside the 80% safe zone.
  ["icon-maskable-512.png", 512, 0.1],
  ["favicon-32.png", 32, 0],
  ["badge-96.png", 96, 0],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of icons) {
  const inner = Math.round(size * (1 - pad * 2));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:#05060c;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;overflow:hidden">${svgAt(inner)}</body></html>`,
  );
  await page.screenshot({ path: `app/public/icons/${name}` });
}

// Launch screens (apple-touch-startup-image), in device pixels. iPhone 15 Pro Max first.
const splashes = [
  ["splash-1290x2796.png", 1290, 2796], // iPhone 15 Pro Max, 16 Plus, 14 Pro Max
  ["splash-1179x2556.png", 1179, 2556], // iPhone 15 Pro, 15, 16
  ["splash-1320x2868.png", 1320, 2868], // iPhone 16 Pro Max
];
for (const [name, w, h] of splashes) {
  await page.setViewportSize({ width: w, height: h });
  const icon = Math.round(w * 0.3);
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;background:radial-gradient(120% 70% at 50% 35%,#161b38 0%,#0a0c18 55%,#05060c 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(w * 0.05)}px;font-family:-apple-system,'SF Pro Display','Inter',system-ui,sans-serif">
    <div style="width:${icon}px;height:${icon}px;border-radius:${Math.round(icon * 0.225)}px;overflow:hidden;box-shadow:0 ${Math.round(w * 0.02)}px ${Math.round(w * 0.08)}px rgba(241,196,94,.25)">${svgAt(icon)}</div>
    <div style="color:#efe6cf;font-size:${Math.round(w * 0.075)}px;font-weight:700;letter-spacing:.02em">Muninn</div>
  </body></html>`);
  await page.screenshot({ path: `app/public/icons/${name}` });
}
await browser.close();

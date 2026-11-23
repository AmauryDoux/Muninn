// Renders app/public/icons/raven.svg to the PNG sizes the manifest and iOS need.
// Run once after changing the SVG: node scripts/render-icons.mjs (needs Playwright's Chromium).
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const svg = readFileSync("app/public/icons/raven.svg", "utf8");
const sizes = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["apple-touch-icon.png", 180, 0],
  ["icon-maskable-512.png", 512, 0.1],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of sizes) {
  const inner = Math.round(size * (1 - pad * 2));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:#14161a;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: `app/public/icons/${name}`, omitBackground: false });
}
await browser.close();

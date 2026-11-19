// Renders the PWA icons from the wave mark. Run once after changing the mark:
//   node apps/web/scripts/make-icons.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/', import.meta.url));
const waves = (stroke = 1) => `
  <path d="M10 38c6 0 6-6 12-6s6 6 12 6 6-6 12-6 6 6 8 6" fill="none" stroke="#fff" stroke-width="${5 * stroke}" stroke-linecap="round"/>
  <path d="M10 26c6 0 6-6 12-6s6 6 12 6 6-6 12-6 6 6 8 6" fill="none" stroke="#E8F2F9" stroke-width="${4 * stroke}" stroke-linecap="round" opacity=".7"/>`;
// "any": rounded tile. "maskable": full bleed, mark inside the 80 % safe zone.
const any = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0B5C8E"/>${waves()}</svg>`;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0B5C8E"/><g transform="translate(9.6 9.6) scale(.7)">${waves(1.2)}</g></svg>`;
const jobs = [
  ['pwa-192.png', any, 192],
  ['pwa-512.png', any, 512],
  ['pwa-maskable-512.png', maskable, 512],
  ['apple-touch-icon.png', maskable, 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, svg, size] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.locator('svg').screenshot({ path: out + name, omitBackground: true });
}
await browser.close();
console.log('icons written to', out);

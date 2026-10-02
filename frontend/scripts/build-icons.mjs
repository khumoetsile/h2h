// Builds the small icon font the app actually ships.
//
// The full Material Symbols font is 5.4 MB; this app uses a few dozen icons.
// We collect every word in the source that is a real icon name, ask Google
// Fonts for a font containing only those, and save it into /public so it is
// served from our own origin (no third party in the critical path).
//
// Run `npm run icons` after adding an icon. The unit test in
// src/app/icons.spec.ts fails if a used icon is missing from the font.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export function allIconNames() {
  const dts = fs.readFileSync(path.join(root, 'node_modules/material-symbols/index.d.ts'), 'utf8');
  return new Set([...dts.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|html)$/.test(f) && !/\.spec\.ts$/.test(f)) out.push(p);
  }
  return out;
}

/** Every word in the source that is also an icon name: a safe superset of what is really used. */
export function usedIconNames() {
  const valid = allIconNames();
  const used = new Set();
  for (const file of walk(path.join(root, 'src'))) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/[a-z][a-z0-9_]*/g)) if (valid.has(m[0])) used.add(m[0]);
  }
  return [...used].sort();
}

async function main() {
  const names = usedIconNames();
  const url = `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0..1,0&icon_names=${names.join(',')}&display=block`;
  const css = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const src = css.match(/src:\s*url\(([^)]+)\)\s*format\('woff2'\)/)?.[1];
  if (!src) throw new Error('Could not find the font URL in the response:\n' + css.slice(0, 400));
  const font = Buffer.from(await (await fetch(src, { headers: { 'User-Agent': UA } })).arrayBuffer());
  fs.mkdirSync(path.join(root, 'public/fonts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public/fonts/material-symbols-subset.woff2'), font);
  fs.writeFileSync(path.join(root, 'src/icons.generated.json'), JSON.stringify(names, null, 2) + '\n');
  stampFontVersion();
  console.log(`Icon font: ${names.length} icons, ${(font.length / 1024).toFixed(1)} kB`);
}

/**
 * Browsers keep the font for a week, so its URL carries a version taken from its bytes. Without this a phone that
 * already has the old font keeps it and shows broken boxes where a newly added icon should be.
 */
const cssPath = path.join(root, 'src/material-symbols-subset.css');
const fontVersion = () => crypto.createHash('md5').update(fs.readFileSync(path.join(root, 'public/fonts/material-symbols-subset.woff2'))).digest('hex').slice(0, 8);
function stampFontVersion() {
  const css = fs.readFileSync(cssPath, 'utf8').replace(/material-symbols-subset\.woff2(\?v=[0-9a-f]+)?/, `material-symbols-subset.woff2?v=${fontVersion()}`);
  fs.writeFileSync(cssPath, css);
}

/** Fails (exit 1) if the source uses an icon that the shipped font does not contain. */
function check() {
  const shipped = new Set(JSON.parse(fs.readFileSync(path.join(root, 'src/icons.generated.json'), 'utf8')));
  const missing = usedIconNames().filter((n) => !shipped.has(n));
  const size = fs.statSync(path.join(root, 'public/fonts/material-symbols-subset.woff2')).size;
  if (!fs.readFileSync(cssPath, 'utf8').includes(`woff2?v=${fontVersion()}`)) {
    console.error('The icon font changed but its URL version did not.\nRun: npm run icons');
    process.exit(1);
  }
  if (missing.length) {
    console.error(`Icons used in the source but missing from the icon font: ${missing.join(', ')}
Run: npm run icons`);
    process.exit(1);
  }
  if (size > 120 * 1024) { console.error(`Icon font is ${Math.round(size / 1024)} kB, expected a small subset.`); process.exit(1); }
  console.log(`Icon font OK (${shipped.size} icons, ${(size / 1024).toFixed(1)} kB).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check(); else await main();
}

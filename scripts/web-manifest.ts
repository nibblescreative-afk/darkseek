// The website build manifest published with each release (docs/verify.md):
// the sha256 of every file the site serves, and one hash over all of them.
//
//   npx tsx scripts/web-manifest.ts <dist dir> [--version v0.2.0]   writes the manifest to stdout
//   npx tsx scripts/web-manifest.ts --check <manifest.json> <site url>
//       fetches every file the manifest lists from the site and compares

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface WebManifest {
  version: string;
  /** sha256 over the sorted "hash  path" lines, so one value names the whole build */
  root: string;
  files: Record<string, string>;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function rootOf(files: Record<string, string>): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map((p) => `${files[p]}  ${p}\n`)
      .join(''),
  );
}

export function manifestOf(dir: string, version: string): WebManifest {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files['/' + path.relative(dir, full).split(path.sep).join('/')] = sha256(fs.readFileSync(full));
    }
  };
  walk(dir);
  return { version, root: rootOf(files), files };
}

async function check(manifestPath: string, site: string): Promise<number> {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as WebManifest;
  if (rootOf(m.files) !== m.root) {
    console.error('the manifest does not match its own root hash');
    return 1;
  }
  let bad = 0;
  for (const [p, hash] of Object.entries(m.files)) {
    const res = await fetch(new URL(p, site));
    const body = Buffer.from(await res.arrayBuffer());
    const ok = res.ok && sha256(body) === hash;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${p}`);
  }
  console.log(bad ? `${bad} file(s) differ from the published build` : `the site serves build ${m.root}`);
  return bad ? 1 : 0;
}

const args = process.argv.slice(2);
if (args[0] === '--check') {
  check(args[1], args[2]).then((code) => process.exit(code));
} else if (args[0]) {
  const v = args.indexOf('--version');
  console.log(JSON.stringify(manifestOf(args[0], v >= 0 ? args[v + 1] : 'unversioned'), null, 2));
} else {
  console.error('usage: web-manifest.ts <dist dir> [--version v] | --check <manifest.json> <site url>');
  process.exit(2);
}

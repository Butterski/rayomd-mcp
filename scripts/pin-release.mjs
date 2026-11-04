#!/usr/bin/env node
// Pins a RayoMD release: downloads its static Linux tarball and Windows zip from GitHub, computes
// their SHA-256, checks them against the digests GitHub reports for the assets, and writes them
// into src/client/releases.ts as the default version. Usage: npm run pin-release -- 5.3.0

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version || !/^\d+(\.\d+){1,3}$/.test(version)) {
    console.error('usage: npm run pin-release -- <version>   (such as 5.3.0)');
    process.exit(2);
}
const assets = {
    'linux-x64': `rayomd-${version}-linux-x64-static.tar.gz`,
    'win32-x64': `rayomd-${version}-windows-x64.zip`,
};

const headers = { 'User-Agent': 'rayomd-mcp-pin-release', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const response = await fetch(`https://api.github.com/repos/Butterski/rayomd/releases/tags/v${version}`, { headers });
if (!response.ok) {
    console.error(`pin-release: no GitHub release v${version} (HTTP ${response.status})`);
    process.exit(1);
}
const release = await response.json();

const hashes = {};
for (const [platform, name] of Object.entries(assets)) {
    const asset = release.assets.find(candidate => candidate.name === name);
    if (!asset) {
        console.error(`pin-release: v${version} has no asset ${name}`);
        process.exit(1);
    }
    const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': headers['User-Agent'] } });
    if (!download.ok) {
        console.error(`pin-release: downloading ${name} failed (HTTP ${download.status})`);
        process.exit(1);
    }
    const sha256 = createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex');
    if (asset.digest && asset.digest !== `sha256:${sha256}`) {
        console.error(`pin-release: ${name} hashes to ${sha256}, GitHub reports ${asset.digest}`);
        process.exit(1);
    }
    console.log(`${platform}  ${sha256}  ${name}${asset.digest ? ' (matches GitHub digest)' : ''}`);
    hashes[platform] = sha256;
}

const file = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src', 'client', 'releases.ts');
let source = readFileSync(file, 'utf8');
source = source.replace(/export const RAYOMD_VERSION = '[^']*';/, `export const RAYOMD_VERSION = '${version}';`);
const entry = `    '${version}': {\n${Object.entries(hashes).map(([platform, sha]) => `        '${platform}': '${sha}',`).join('\n')}\n    },\n`;
const existing = new RegExp(`    '${version.replace(/\./g, '\\.')}': \\{[^}]*\\},\\n`);
const opening = 'export const RELEASE_SHA256: ReleaseTable = {\n';
source = existing.test(source) ? source.replace(existing, entry) : source.replace(opening, `${opening}${entry}`);
writeFileSync(file, source);
console.log(`pin-release: ${path.relative(process.cwd(), file)} now downloads RayoMD ${version}`);

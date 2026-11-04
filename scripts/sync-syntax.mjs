#!/usr/bin/env node
// Copies the RayoMD skill's syntax reference into resources/syntax.md, the text of the
// rayomd://syntax resource. Source: the first argument, else RAYOMD_SYNTAX_MD, else
// ../rayomd/skills/rayomd/references/syntax.md next to this repository.
// Run it when the reference changes, and commit resources/syntax.md.

import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2] ?? process.env.RAYOMD_SYNTAX_MD ??
    path.join(root, '..', 'rayomd', 'skills', 'rayomd', 'references', 'syntax.md');
if (!existsSync(source)) {
    console.error(`sync-syntax: ${source} does not exist; pass the path of skills/rayomd/references/syntax.md.`);
    process.exit(1);
}
const target = path.join(root, 'resources', 'syntax.md');
copyFileSync(source, target);
console.log(`sync-syntax: ${source} -> ${target}`);

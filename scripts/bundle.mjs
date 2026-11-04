#!/usr/bin/env node
// The `rayomd-mcp` executable: dist/cli.js and everything it imports (the SDK, zod) as one
// minified module, dist/rayomd-mcp.mjs. Node then reads, resolves and compiles one file where it
// took some 150 modules: initialize answered 237 ms after the start instead of 390 (2026-11-04,
// node 22, 54 ms of it node's own start). Run after tsc (npm run build).

import { build } from 'esbuild';

await build({
    entryPoints: ['dist/cli.js'],
    outfile: 'dist/rayomd-mcp.mjs',
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
    // A dependency that calls require() keeps working in the ES module.
    banner: { js: 'import { createRequire as __rayomdRequire } from "node:module"; const require = __rayomdRequire(import.meta.url);' },
});

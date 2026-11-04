#!/usr/bin/env node
// rayomd-mcp: the RayoMD MCP server over stdio.

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { resolveRayomd } from './client/binary.js';
import { Roots } from './paths.js';
import { type Allowances, RayomdMcp, SERVER_VERSION } from './server.js';

const USAGE = `rayomd-mcp ${SERVER_VERSION}: Markdown to PDF with RayoMD, as an MCP server on stdio.

Usage: rayomd-mcp [--root DIR]... [--allow-url-images] [--allow-unsafe-local-images]
                  [--allow-theme] [--allow-embed-source] [--timeout SECONDS]
       rayomd-mcp --install-binary    resolve or download rayomd and print its path
       rayomd-mcp --version | --help

--root DIR       a folder tools may read and write in (repeatable; default the working folder)
--allow-*        add the matching tool option (off by default)
--timeout N      seconds one conversion may take (default 60)

Environment: RAYOMD_PATH (the rayomd binary), RAYOMD_GUI_PATH (the RayoMD GUI binary).
`;

function fail(message: string): never {
    process.stderr.write(`rayomd-mcp: ${message}\n\n${USAGE}`);
    process.exit(2);
}

const roots: string[] = [];
const allow: Allowances = {};
let timeoutMs = 60_000;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string => {
        const next = inline ?? argv[++i];
        if (next === undefined || next === '') fail(`${flag} needs a value`);
        return next;
    };
    switch (flag) {
        case '--help':
        case '-h':
            process.stdout.write(USAGE);
            process.exit(0);
        case '--version':
            process.stdout.write(`rayomd-mcp ${SERVER_VERSION}\n`);
            process.exit(0);
        case '--install-binary': {
            const binary = await resolveRayomd({ log: message => process.stderr.write(`${message}\n`) });
            process.stdout.write(`${binary.path}\n`);
            process.exit(0);
        }
        case '--root':
            roots.push(value());
            break;
        case '--allow-url-images':
            allow.urlImages = true;
            break;
        case '--allow-unsafe-local-images':
            allow.unsafeLocalImages = true;
            break;
        case '--allow-theme':
            allow.theme = true;
            break;
        case '--allow-embed-source':
            allow.embedSource = true;
            break;
        case '--timeout': {
            const seconds = Number(value());
            if (!Number.isFinite(seconds) || seconds <= 0) fail('--timeout must be a positive number of seconds');
            timeoutMs = seconds * 1000;
            break;
        }
        default:
            fail(`unknown argument ${arg}`);
    }
}

let mcp: RayomdMcp;
try {
    mcp = new RayomdMcp({ roots: await Roots.create(roots), allow, requestTimeoutMs: timeoutMs });
} catch (error) {
    fail((error as Error).message);
}

process.on('exit', () => mcp.serve.kill());
const handle = serveStdio(() => {
    const server = mcp.createServer();
    // stdin closed: the client is gone; end the rayomd child so the process exits.
    server.server.onclose = () => void mcp.close();
    return server;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void handle.close().finally(() => mcp.close()).finally(() => process.exit(0));
    });
}
process.stderr.write(`rayomd-mcp ${SERVER_VERSION} on stdio; roots: ${mcp.roots.dirs.join(', ')}\n`);

// Test wiring: temporary roots, the fake rayomd, and SDK clients connected in memory to a
// RayomdMcp server, in the 2025 era (InMemoryTransport) or the 2026-07-28 era (createMcpHandler).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { RayomdMcp, Roots } from '../dist/index.js';

export const FAKE_RAYOMD = fileURLToPath(new URL('./fake-rayomd.mjs', import.meta.url));
export const fakeCommand = { command: process.execPath, args: [FAKE_RAYOMD] };

/** A new empty folder, by its real path as the system resolves it (no 8.3 short names on Windows). */
export function tempDir(prefix = 'rayomd-mcp-test-') {
    return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeDir(dir) {
    rmSync(dir, { recursive: true, force: true });
}

/**
 * A RayomdMcp on `roots` and a connected client. `era` 'legacy' pairs them with
 * InMemoryTransport (a 2025-era initialize), 'modern' through createMcpHandler's fetch (2026-07-28).
 */
export async function connect({ roots, rayomd = fakeCommand, allow, requestTimeoutMs, env, era = 'legacy' }) {
    const mcp = new RayomdMcp({ roots: await Roots.create(roots), rayomd, allow, requestTimeoutMs, env, log: () => {} });
    let client;
    let closeServer;
    if (era === 'modern') {
        const handler = createMcpHandler(() => mcp.createServer());
        client = new Client({ name: 'rayomd-mcp-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
        await client.connect(new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
            fetch: (url, init) => handler.fetch(new Request(url, init)),
        }));
        closeServer = () => handler.close();
    } else {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const server = mcp.createServer();
        await server.connect(serverTransport);
        client = new Client({ name: 'rayomd-mcp-test', version: '1.0.0' });
        await client.connect(clientTransport);
        closeServer = () => server.close();
    }
    return {
        mcp,
        client,
        async close() {
            await client.close();
            await closeServer();
            await mcp.close();
        },
    };
}

/** The text of a tool result's first text block. */
export function textOf(result) {
    return result.content.find(block => block.type === 'text')?.text ?? '';
}

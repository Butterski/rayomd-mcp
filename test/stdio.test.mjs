// The built CLI over stdio, spawned by the SDK's StdioClientTransport, for a 2025-era client
// (initialize) and a 2026-07-28 client (server/discover).

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { removeDir, tempDir } from './helpers.mjs';
import { LineReadBuffer } from '../dist/stdio.js';

const CLI = fileURLToPath(new URL('../dist/rayomd-mcp.mjs', import.meta.url));
let root;
before(() => {
    root = tempDir();
});
after(() => removeDir(root));

for (const [era, options] of [['legacy', {}], ['modern', { versionNegotiation: { mode: { pin: '2026-07-28' } } }]]) {
    test(`the rayomd-mcp executable serves a ${era} client over stdio`, async () => {
        const client = new Client({ name: 'stdio-test', version: '1.0.0' }, options);
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--root', root], stderr: 'ignore' }));
        try {
            assert.equal(client.getProtocolEra(), era);
            const { tools } = await client.listTools();
            assert.deepEqual(tools.map(tool => tool.name).sort(), ['book_to_pdf', 'markdown_to_pdf', 'open_in_gui', 'recover_markdown']);
            const refused = await client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: '# x', output: '../escape.pdf' } });
            assert.equal(refused.isError, true);
            const syntax = await client.readResource({ uri: 'rayomd://syntax' });
            assert.match(syntax.contents[0].text, /RayoMD/);
        } finally {
            await client.close();
        }
    });
}

test('the rayomd-mcp executable refuses unknown arguments and a missing root', async () => {
    const { execFileSync } = await import('node:child_process');
    for (const args of [['--bogus'], ['--root', `${root}/missing`]]) {
        assert.throws(() => execFileSync(process.execPath, [CLI, ...args], { stdio: 'pipe' }), error => error.status === 2);
    }
});

test('LineReadBuffer: messages split at every byte, CRLF, lines that are not JSON, the limit', () => {
    const messages = [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: { markdown: 'é\u4e2d😀 "q"\n' } } },
    ];
    const bytes = Buffer.from(`${JSON.stringify(messages[0])}\r\nnot json\n${JSON.stringify(messages[1])}\n`);
    for (let cut = 0; cut <= bytes.length; cut++) {
        for (const step of [1, 7, bytes.length]) {
            const buffer = new LineReadBuffer(1024);
            const read = [];
            // The first `cut` bytes, then pieces of `step` bytes.
            const chunks = cut > 0 ? [bytes.subarray(0, cut)] : [];
            for (let at = cut; at < bytes.length; at += step) chunks.push(bytes.subarray(at, at + step));
            for (const chunk of chunks) {
                buffer.append(chunk);
                for (let message = buffer.readMessage(); message; message = buffer.readMessage()) read.push(message);
            }
            assert.deepEqual(read, messages, `cut ${cut}, step ${step}`);
        }
    }
    const limited = new LineReadBuffer(16);
    limited.append(Buffer.from('0123456789'));
    assert.throws(() => limited.append(Buffer.from('0123456789')), /maximum size of 16 bytes/);
    limited.append(Buffer.from('{"jsonrpc":"2.0","id":3,"method":"ping"}'.slice(0, 10)));
    assert.equal(limited.readMessage(), null);
});

test('the rayomd-mcp executable reads a call larger than the SDK\'s 10 MB stdio limit', async () => {
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--root', root], stderr: 'ignore' }));
    try {
        // Refused by the root check: the call reached the tool, without starting rayomd.
        const result = await client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'x'.repeat(12 * 1024 * 1024), output: '../escape.pdf' } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /outside the folders/);
    } finally {
        await client.close();
    }
});

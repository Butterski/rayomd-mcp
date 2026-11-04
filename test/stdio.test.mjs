// The built CLI over stdio, spawned by the SDK's StdioClientTransport, for a 2025-era client
// (initialize) and a 2026-07-28 client (server/discover).

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { removeDir, tempDir } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
let root;
before(() => {
    root = tempDir();
});
after(() => removeDir(root));

for (const [era, options] of [['legacy', {}], ['modern', { versionNegotiation: { mode: { pin: '2026-07-28' } } }]]) {
    test(`dist/cli.js serves a ${era} client over stdio`, async () => {
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

test('dist/cli.js refuses unknown arguments and a missing root', async () => {
    const { execFileSync } = await import('node:child_process');
    for (const args of [['--bogus'], ['--root', `${root}/missing`]]) {
        assert.throws(() => execFileSync(process.execPath, [CLI, ...args], { stdio: 'pipe' }), error => error.status === 2);
    }
});

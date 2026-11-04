// The MCP server through the SDK's client, in memory, against the fake rayomd.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { connect, removeDir, tempDir, textOf } from './helpers.mjs';

const FLAG_OPTIONS = ['allow_url_images', 'allow_unsafe_local_images', 'theme', 'embed_source'];

describe('rayomd-mcp server (fake rayomd)', () => {
    let base;
    let root;
    let other;
    before(() => {
        base = tempDir();
        root = path.join(base, 'root');
        other = path.join(base, 'other');
        mkdirSync(path.join(root, 'book'), { recursive: true });
        mkdirSync(other);
        writeFileSync(path.join(root, 'note.md'), '# Note\n\nText.\n');
        writeFileSync(path.join(root, 'book', 'SUMMARY.md'), '# Summary\n\n- [One](one.md)\n');
        writeFileSync(path.join(root, 'book', 'one.md'), '# One\n');
        writeFileSync(path.join(other, 'secret.md'), '# secret');
    });
    after(() => removeDir(base));

    for (const era of ['legacy', 'modern']) {
        test(`lists the tools with schemas, annotations and the syntax resource (${era} era)`, async () => {
            const session = await connect({ roots: [root], era });
            try {
                const { tools } = await session.client.listTools();
                const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
                assert.deepEqual(Object.keys(byName).sort(), ['book_to_pdf', 'markdown_to_pdf', 'open_in_gui', 'recover_markdown']);
                for (const tool of tools) {
                    assert.equal(tool.inputSchema.type, 'object', tool.name);
                    assert.equal(tool.outputSchema?.type, 'object', tool.name);
                }
                const md = byName.markdown_to_pdf;
                assert.deepEqual(md.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
                assert.match(md.description, /rayomd:\/\/syntax/);
                assert.deepEqual(md.inputSchema.required, ['output']);
                for (const option of ['markdown', 'path', 'source_path', 'style', 'margin', 'page_size', 'toc', 'toc_depth', 'number_headings',
                    'page_numbers', 'footnotes', 'dialect', 'pdfa', 'pdfua', 'black_text', 'highlight_code', 'diagrams', 'page_break_before']) {
                    assert.ok(md.inputSchema.properties[option], option);
                }
                for (const option of FLAG_OPTIONS) assert.equal(md.inputSchema.properties[option], undefined, option);
                assert.deepEqual(Object.keys(md.outputSchema.properties).sort(),
                    ['bytes', 'code', 'error', 'failed_images', 'input', 'missing_characters', 'ms', 'output', 'pages', 'status']);
                const { resources } = await session.client.listResources();
                assert.deepEqual(resources.map(resource => resource.uri), ['rayomd://syntax']);
                const syntax = await session.client.readResource({ uri: 'rayomd://syntax' });
                assert.match(syntax.contents[0].text, /^# What RayoMD renders/);
            } finally {
                await session.close();
            }
        });
    }

    test('the server command line adds the resource options', async () => {
        const session = await connect({ roots: [root], allow: { urlImages: true, unsafeLocalImages: true, theme: true, embedSource: true } });
        try {
            const { tools } = await session.client.listTools();
            const md = tools.find(tool => tool.name === 'markdown_to_pdf');
            for (const option of FLAG_OPTIONS) assert.ok(md.inputSchema.properties[option], option);
            const book = tools.find(tool => tool.name === 'book_to_pdf');
            assert.equal(book.inputSchema.properties.embed_source, undefined);
        } finally {
            await session.close();
        }
    });

    test('options not allowed by the command line never reach rayomd', async () => {
        const session = await connect({ roots: [root] });
        try {
            const result = await session.client.callTool({
                name: 'markdown_to_pdf',
                arguments: { markdown: '# x', output: 'gated.pdf', allow_url_images: true, embed_source: true, theme: '/etc/passwd' },
            });
            assert.equal(result.isError, undefined, textOf(result));
            assert.equal(readFileSync(path.join(root, 'gated.pdf'), 'utf8').split('\n')[1], '[]');
        } finally {
            await session.close();
        }
    });

    for (const era of ['legacy', 'modern']) {
        test(`markdown_to_pdf from text: flags, source_path, structuredContent and resource_link (${era} era)`, async () => {
            const session = await connect({ roots: [root], era });
            try {
                const result = await session.client.callTool({
                    name: 'markdown_to_pdf',
                    arguments: {
                        markdown: '# Hello\n', output: 'hello.pdf', style: 'modern', margin: 'wide', page_size: 'letter', toc: true, toc_depth: 2,
                        number_headings: 3, page_numbers: true, footnotes: 'page', dialect: 'obsidian', pdfa: true, pdfua: true,
                        black_text: true, highlight_code: false, diagrams: false, page_break_before: 'h2',
                    },
                });
                assert.equal(result.isError, undefined, textOf(result));
                const output = path.join(root, 'hello.pdf');
                assert.deepEqual(result.structuredContent, {
                    input: path.join(root, 'hello.md'), output, status: 'ok', code: 0, pages: 1,
                    bytes: readFileSync(output).length, ms: 0.1, missing_characters: 0, failed_images: 0,
                });
                assert.deepEqual(JSON.parse(readFileSync(output, 'utf8').split('\n')[1]), [
                    'modern', 'wide', '--page-size=letter', '--toc', '--toc-depth=2', '--number-headings=3', '--page-numbers',
                    '--footnotes=page', '--dialect=obsidian', '--pdfa', '--pdfua', '--black-text', '--no-highlight', '--no-diagrams',
                    '--page-break-before=h2',
                ]);
                assert.match(textOf(result), /^Wrote .*hello\.pdf: 1 page, \d+ bytes/);
                const link = result.content.find(block => block.type === 'resource_link');
                assert.deepEqual(link, { type: 'resource_link', uri: pathToFileURL(output).href, name: 'hello.pdf', mimeType: 'application/pdf' });
            } finally {
                await session.close();
            }
        });
    }

    test('markdown_to_pdf from a path, and a given source_path', async () => {
        const session = await connect({ roots: [root] });
        try {
            const fromPath = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { path: 'note.md', output: 'note.pdf' } });
            assert.equal(fromPath.structuredContent.input, path.join(root, 'note.md'));
            assert.match(readFileSync(path.join(root, 'note.pdf'), 'utf8'), /# Note/);
            const withSource = await session.client.callTool({
                name: 'markdown_to_pdf', arguments: { markdown: 'MISSING glyphs', output: 'x.pdf', source_path: 'book/virtual.md' },
            });
            assert.equal(withSource.structuredContent.input, path.join(root, 'book', 'virtual.md'));
            assert.match(textOf(withSource), /2 characters without a glyph/);
        } finally {
            await session.close();
        }
    });

    test('markdown_to_pdf refuses bad arguments and paths outside the roots', async () => {
        const session = await connect({ roots: [root] });
        const call = args => session.client.callTool({ name: 'markdown_to_pdf', arguments: args });
        try {
            const cases = [
                [{ output: 'x.pdf' }, /exactly one of markdown and path/],
                [{ markdown: 'a', path: 'note.md', output: 'x.pdf' }, /exactly one of markdown and path/],
                [{ path: '../other/secret.md', output: 'x.pdf' }, /outside the folders/],
                [{ path: path.join(other, 'secret.md'), output: 'x.pdf' }, /outside the folders/],
                [{ markdown: 'a', output: '../other/x.pdf' }, /outside the folders/],
                [{ markdown: 'a', output: path.join(other, 'x.pdf') }, /outside the folders/],
                [{ markdown: 'a', output: 'x.txt' }, /must end in .pdf/],
                [{ markdown: 'a', output: 'x.pdf', source_path: '../other/s.md' }, /outside the folders/],
                [{ markdown: 'a', output: 'x.pdf', margin: 'huge' }, /margin/],
                [{ markdown: 'a', output: 'x.pdf', toc_depth: 9 }, /toc_depth/],
                [{ markdown: 'a', output: 'x.pdf', style: 'fancy' }, /style/],
            ];
            for (const [args, pattern] of cases) {
                const result = await call(args);
                assert.equal(result.isError, true, JSON.stringify(args));
                assert.match(textOf(result), pattern, JSON.stringify(args));
            }
            assert.equal(existsSync(path.join(other, 'x.pdf')), false);
            try {
                symlinkSync(path.join(other, 'secret.md'), path.join(root, 'escape.md'));
            } catch {
                return;
            }
            const linked = await call({ path: 'escape.md', output: 'x.pdf' });
            assert.match(textOf(linked), /outside the folders/);
        } finally {
            await session.close();
        }
    });

    test('a crashed rayomd fails the call; the next call starts a new one', async () => {
        const session = await connect({ roots: [root] });
        try {
            const crashed = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'CRASH', output: 'c.pdf' } });
            assert.equal(crashed.isError, true);
            assert.match(textOf(crashed), /rayomd exited with code 3.*next request starts rayomd again/s);
            const next = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'ok', output: 'c.pdf' } });
            assert.equal(next.structuredContent.status, 'ok');
        } finally {
            await session.close();
        }
    });

    test('a hanging rayomd times out; the next call works', async () => {
        const session = await connect({ roots: [root], requestTimeoutMs: 300 });
        try {
            const hung = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'HANG', output: 'h.pdf' } });
            assert.match(textOf(hung), /did not answer the request within 0.3 s/);
            const next = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'ok', output: 'h.pdf' } });
            assert.equal(next.structuredContent.status, 'ok');
        } finally {
            await session.close();
        }
    });

    test('book_to_pdf runs rayomd --book on checked inputs', async () => {
        const session = await connect({ roots: [root] });
        try {
            const result = await session.client.callTool({
                name: 'book_to_pdf', arguments: { inputs: ['book/SUMMARY.md', 'note.md'], output: 'book.pdf', toc: true, page_numbers: true },
            });
            assert.equal(result.isError, undefined, textOf(result));
            const output = path.join(root, 'book.pdf');
            const { ms, ...record } = result.structuredContent;
            assert.equal(typeof ms, 'number');
            assert.deepEqual(record, {
                inputs: [path.join(root, 'book', 'SUMMARY.md'), path.join(root, 'note.md')], output, status: 'ok', code: 0, pages: 2,
                bytes: readFileSync(output).length, missing_characters: 0,
            });
            assert.match(readFileSync(output, 'utf8'), /\["--toc","--page-numbers"\]/);
            assert.ok(result.content.some(block => block.type === 'resource_link'));
            const outside = await session.client.callTool({ name: 'book_to_pdf', arguments: { inputs: ['../other'], output: 'b.pdf' } });
            assert.match(textOf(outside), /outside the folders/);
            const pdfInput = await session.client.callTool({ name: 'book_to_pdf', arguments: { inputs: ['book.pdf'], output: 'b.pdf' } });
            assert.match(textOf(pdfInput), /is a PDF/);
        } finally {
            await session.close();
        }
    });

    test('recover_markdown returns the text or writes a new file, never over one', async () => {
        const session = await connect({ roots: [root], allow: { embedSource: true } });
        try {
            const exported = await session.client.callTool({
                name: 'markdown_to_pdf', arguments: { markdown: '# Reversible\n', output: 'rev.pdf', embed_source: true },
            });
            assert.equal(exported.isError, undefined, textOf(exported));
            const text = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'rev.pdf' } });
            assert.equal(text.isError, undefined, textOf(text));
            assert.deepEqual(text.structuredContent, { input: path.join(root, 'rev.pdf'), bytes: 13, markdown: '# Reversible\n' });
            assert.equal(textOf(text), '# Reversible\n');
            const file = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'rev.pdf', output: 'rev.md' } });
            assert.equal(readFileSync(path.join(root, 'rev.md'), 'utf8'), '# Reversible\n');
            assert.equal(file.structuredContent.output, path.join(root, 'rev.md'));
            const again = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'rev.pdf', output: 'rev.md' } });
            assert.match(textOf(again), /already exists/);
            const plain = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: 'x', output: 'plain.pdf' } });
            assert.equal(plain.isError, undefined);
            const none = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'plain.pdf' } });
            assert.match(textOf(none), /no embedded RayoMD source/);
        } finally {
            await session.close();
        }
    });

    test('open_in_gui: clear errors without a GUI, outside the roots or for other files', async () => {
        const session = await connect({ roots: [root], env: { PATH: '' } });
        try {
            const missing = await session.client.callTool({ name: 'open_in_gui', arguments: { path: 'note.md' } });
            assert.match(textOf(missing), /RayoMD GUI is not installed/);
            const outside = await session.client.callTool({ name: 'open_in_gui', arguments: { path: '../other/secret.md' } });
            assert.match(textOf(outside), /outside the folders/);
            const notMarkdown = await session.client.callTool({ name: 'open_in_gui', arguments: { path: 'book.pdf' } });
            assert.match(textOf(notMarkdown), /does not end in .md|does not exist/);
        } finally {
            await session.close();
        }
    });

    test('open_in_gui starts the GUI detached on the file', { skip: process.platform === 'win32' && 'needs a POSIX shell script' }, async () => {
        const gui = path.join(base, 'fake-gui.sh');
        const marker = path.join(base, 'gui-opened.txt');
        writeFileSync(gui, `#!/bin/sh\nprintf '%s' "$1" > '${marker}'\nsleep 2\n`);
        chmodSync(gui, 0o755);
        const session = await connect({ roots: [root], env: { RAYOMD_GUI_PATH: gui, WAYLAND_DISPLAY: 'wayland-test', PATH: process.env.PATH } });
        try {
            const result = await session.client.callTool({ name: 'open_in_gui', arguments: { path: 'note.md' } });
            assert.equal(result.isError, undefined, textOf(result));
            assert.equal(result.structuredContent.file, path.join(root, 'note.md'));
            assert.equal(readFileSync(marker, 'utf8'), path.join(root, 'note.md'));
            if (process.platform === 'linux') {
                const noDisplay = await connect({ roots: [root], env: { RAYOMD_GUI_PATH: gui } });
                const refused = await noDisplay.client.callTool({ name: 'open_in_gui', arguments: { path: 'note.md' } });
                assert.match(textOf(refused), /No Wayland display/);
                await noDisplay.close();
            }
        } finally {
            await session.close();
        }
    });
});

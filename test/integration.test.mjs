// The server against a real rayomd with --serve --json: PDFs byte-identical to `rayomd --export`
// and `rayomd --book` with the same flags, recover_markdown on a reversible PDF, a killed child.
// Runs when RAYOMD_TEST_BINARY names that rayomd; skipped otherwise.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { connect, removeDir, tempDir, textOf } from './helpers.mjs';

const binary = process.env.RAYOMD_TEST_BINARY;
const rayomd = binary ? { command: path.resolve(binary) } : undefined;

const NOTE = [
    '---', 'title: Integration', '---', '', '# Report', '', 'A formula $e^{i\\pi} + 1 = 0$ and a footnote.[^1]', '',
    '```mermaid', 'flowchart LR', '  A[Start] --> B{Ok?}', '  B -->|yes| C[Done]', '```', '',
    '```python', 'def f(x):', '    return x * 2', '```', '',
    '| a | b |', '|---|--:|', '| 1 | 2 |', '', '## Details', '', '> [!NOTE]', '> An alert.', '', '[^1]: The note.', '',
].join('\n');

const CASES = [
    { options: {}, flags: [] },
    { options: { style: 'modern', margin: 'wide', toc: true, page_numbers: true }, flags: ['modern', 'wide', '--toc', '--page-numbers'] },
    {
        options: { style: 'tech', margin: 'margin=0.5in', page_size: 'a5-landscape', number_headings: 2, footnotes: 'page', black_text: true },
        flags: ['tech', 'margin=0.5in', '--page-size=a5-landscape', '--number-headings=2', '--footnotes=page', '--black-text'],
    },
    {
        options: { toc: true, toc_depth: 1, highlight_code: false, diagrams: false, page_break_before: 'h2', dialect: 'obsidian' },
        flags: ['--toc', '--toc-depth=1', '--no-highlight', '--no-diagrams', '--page-break-before=h2', '--dialect=obsidian'],
    },
    { options: { pdfa: true }, flags: ['--pdfa'] },
    { options: { pdfua: true }, flags: ['--pdfua'] },
];

describe('rayomd-mcp server (real rayomd)', { skip: !binary && 'set RAYOMD_TEST_BINARY to a rayomd with --serve --json' }, () => {
    let root;
    let session;
    const exportRef = (args) => execFileSync(rayomd.command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });

    /**
     * Checks `result` against `rayomd ${args}`: the same PDF bytes, or, where rayomd itself fails
     * (--pdfa without any system font), a tool error with the same exit code.
     */
    function assertSameAsCli(result, output, args) {
        let code = 0;
        try {
            exportRef(args);
        } catch (error) {
            code = error.status;
        }
        if (code !== 0) {
            assert.equal(result.isError, true, `rayomd ${args.join(' ')} failed with ${code}, the tool did not`);
            assert.match(textOf(result), new RegExp(`\\(code ${code}\\)`));
            return;
        }
        assert.equal(result.isError, undefined, textOf(result));
        const pdf = readFileSync(path.join(root, output));
        assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
        assert.ok(pdf.equals(readFileSync(path.join(root, args[2]))), 'the PDFs differ');
        if (result.structuredContent.bytes !== undefined) assert.equal(result.structuredContent.bytes, pdf.length);
    }

    before(async () => {
        root = tempDir();
        mkdirSync(path.join(root, 'book'));
        writeFileSync(path.join(root, 'note.md'), NOTE);
        writeFileSync(path.join(root, 'book', 'SUMMARY.md'), '# Summary\n\n- [One](one.md)\n- [Two](two.md)\n');
        writeFileSync(path.join(root, 'book', 'one.md'), '# One\n\nSee [two](two.md).\n');
        writeFileSync(path.join(root, 'book', 'two.md'), '# Two\n\nText.\n');
        session = await connect({ roots: [root], rayomd, allow: { embedSource: true } });
    });
    after(async () => {
        await session?.close();
        removeDir(root);
    });

    CASES.forEach(({ options, flags }, n) => {
        test(`markdown_to_pdf from a path is byte-identical to --export ${flags.join(' ')}`, async () => {
            const result = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { path: 'note.md', output: `path-${n}.pdf`, ...options } });
            assertSameAsCli(result, `path-${n}.pdf`, ['--export', 'note.md', `ref-${n}.pdf`, ...flags]);
        });

        test(`markdown_to_pdf from text is byte-identical to --export of that file ${flags.join(' ')}`, async () => {
            const result = await session.client.callTool({
                name: 'markdown_to_pdf', arguments: { markdown: NOTE, source_path: 'note.md', output: `text-${n}.pdf`, ...options },
            });
            assertSameAsCli(result, `text-${n}.pdf`, ['--export', 'note.md', `ref-${n}.pdf`, ...flags]);
        });
    });

    test('markdown_to_pdf from text without source_path stands for output.md', async () => {
        writeFileSync(path.join(root, 'default.md'), NOTE);
        const result = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: NOTE, output: 'default.pdf' } });
        assert.equal(result.structuredContent.input, path.join(root, 'default.md'));
        assertSameAsCli(result, 'default.pdf', ['--export', 'default.md', 'default-ref.pdf']);
    });

    test('a rayomd error is a tool error', async () => {
        const result = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { path: 'note.md', output: 'x.pdf', page_size: '1x1mm' } });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /page-size/);
    });

    test('book_to_pdf is byte-identical to rayomd --book', async () => {
        const result = await session.client.callTool({
            name: 'book_to_pdf', arguments: { inputs: ['book/SUMMARY.md'], output: 'book.pdf', toc: true, page_numbers: true },
        });
        assert.equal(result.isError, undefined, textOf(result));
        exportRef(['--book', 'book/SUMMARY.md', 'book-ref.pdf', '--toc', '--page-numbers']);
        const pdf = readFileSync(path.join(root, 'book.pdf'));
        assert.ok(pdf.equals(readFileSync(path.join(root, 'book-ref.pdf'))), 'the PDFs differ');
        assert.ok(result.structuredContent.pages >= 3, `pages ${result.structuredContent.pages}`);
        const folder = await session.client.callTool({ name: 'book_to_pdf', arguments: { inputs: ['book'], output: 'folder.pdf' } });
        assert.equal(folder.isError, undefined, textOf(folder));
    });

    test('recover_markdown gets back the source of a PDF made with embed_source', async () => {
        const exported = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { path: 'note.md', output: 'rev.pdf', embed_source: true } });
        assert.equal(exported.isError, undefined, textOf(exported));
        exportRef(['--export', 'note.md', 'rev-ref.pdf', '--embed-source']);
        assert.ok(readFileSync(path.join(root, 'rev.pdf')).equals(readFileSync(path.join(root, 'rev-ref.pdf'))));
        const text = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'rev.pdf' } });
        assert.equal(text.isError, undefined, textOf(text));
        assert.equal(text.structuredContent.markdown, NOTE);
        const file = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'rev.pdf', output: 'recovered.md' } });
        assert.equal(readFileSync(path.join(root, 'recovered.md'), 'utf8'), NOTE);
        assert.equal(file.structuredContent.bytes, Buffer.byteLength(NOTE));
        const plain = await session.client.callTool({ name: 'recover_markdown', arguments: { pdf: 'ref-0.pdf' } });
        assert.equal(plain.isError, true);
    });

    test('a killed rayomd child is replaced by the next call', async () => {
        await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: '# a', output: 'k1.pdf' } });
        const pid = session.mcp.serve.pid;
        assert.ok(pid);
        process.kill(pid, 'SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 200));
        const result = await session.client.callTool({ name: 'markdown_to_pdf', arguments: { markdown: '# b', output: 'k2.pdf' } });
        assert.equal(result.structuredContent?.status, 'ok', textOf(result));
        assert.notEqual(session.mcp.serve.pid, pid);
    });

    test('a 2026-07-28 client gets the same PDF', async () => {
        const modern = await connect({ roots: [root], rayomd, era: 'modern' });
        try {
            const result = await modern.client.callTool({ name: 'markdown_to_pdf', arguments: { path: 'note.md', output: 'modern.pdf' } });
            assert.equal(result.structuredContent.status, 'ok', textOf(result));
            assert.ok(readFileSync(path.join(root, 'modern.pdf')).equals(readFileSync(path.join(root, 'path-0.pdf'))));
        } finally {
            await modern.close();
        }
    });
});

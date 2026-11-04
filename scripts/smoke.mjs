#!/usr/bin/env node
// Smoke test of the built server over stdio with raw JSON-RPC lines, as a 2025-06-18 client sends
// them: initialize, tools/list, tools/call markdown_to_pdf, resources/read rayomd://syntax. Needs a
// rayomd with --serve --json (RAYOMD_PATH, PATH or the pinned download). Prints each answer.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(path.join(tmpdir(), 'rayomd-mcp-smoke-'));
const server = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), '--root', work], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
const waiting = new Map();
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        console.log(`<- ${line.length > 400 ? `${line.slice(0, 400)}...` : line}`);
        waiting.get(message.id)?.(message);
    }
});

let nextId = 1;
function call(method, params) {
    const id = nextId++;
    const { promise, resolve } = Promise.withResolvers();
    waiting.set(id, resolve);
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    console.log(`-> ${line}`);
    server.stdin.write(`${line}\n`);
    return promise;
}

function check(condition, message) {
    if (!condition) {
        console.error(`smoke: FAILED: ${message}`);
        process.exitCode = 1;
    }
}

try {
    const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-smoke', version: '1' } });
    check(init.result?.protocolVersion === '2025-06-18', 'initialize answers protocol 2025-06-18');
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await call('tools/list', {});
    const names = tools.result?.tools?.map(tool => tool.name) ?? [];
    check(['markdown_to_pdf', 'book_to_pdf', 'recover_markdown', 'open_in_gui'].every(name => names.includes(name)), `tools: ${names}`);
    const output = path.join(work, 'smoke.pdf');
    const converted = await call('tools/call', { name: 'markdown_to_pdf', arguments: { markdown: '# Smoke\n\n$x^2$\n', output, toc: true } });
    check(converted.result?.structuredContent?.status === 'ok' && statSync(output).size > 0, 'markdown_to_pdf wrote a PDF');
    check(converted.result?.content?.some(block => block.type === 'resource_link'), 'result has a resource_link');
    const refused = await call('tools/call', { name: 'markdown_to_pdf', arguments: { path: '../../etc/passwd', output: 'x.pdf' } });
    check(refused.result?.isError === true, 'a path outside the root is refused');
    const syntax = await call('resources/read', { uri: 'rayomd://syntax' });
    check(syntax.result?.contents?.[0]?.text?.startsWith('#'), 'rayomd://syntax is Markdown');
} finally {
    server.stdin.end();
    await new Promise(resolve => server.once('close', resolve));
    rmSync(work, { recursive: true, force: true });
}
console.log(process.exitCode ? 'smoke: failed' : 'smoke: ok');

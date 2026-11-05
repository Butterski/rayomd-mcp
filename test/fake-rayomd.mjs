#!/usr/bin/env node
// A stand-in for rayomd in the unit tests: `--serve --json` protocol 1, `--book`,
// `--recover-source` and `--version`. Its "PDF" is text: "%FAKEPDF", the flags as JSON and the
// Markdown, so tests can see what the server asked for. Markdown containing CRASH makes the serve
// child exit mid-request, HANG makes it never answer, GARBAGE makes it answer with a non-JSON line,
// SLOW makes it take 200 ms, blocking as a conversion does.
// FAKE_RAYOMD_OLD=1 behaves as a rayomd without --serve --json (no greeting, waits for paths);
// FAKE_RAYOMD_START_MS=N greets only after N ms, as a cold start would.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

function fakePdf(args, markdown) {
    return `%FAKEPDF\n${JSON.stringify(args)}\n${markdown}`;
}

if (argv[0] === '--version') {
    process.stdout.write('rayomd 0.0.0-fake\n');
    process.exit(0);
}

if (argv[0] === '--recover-source') {
    const [, input, output] = argv;
    const pdf = readFileSync(input, 'utf8');
    const lines = pdf.split('\n');
    if (lines[0] !== '%FAKEPDF' || !JSON.parse(lines[1]).includes('--embed-source')) {
        process.stderr.write('Error: the PDF has no embedded RayoMD source.\n');
        process.exit(30);
    }
    if (existsSync(output)) {
        process.stderr.write(`Error: destination already exists: ${output}\n`);
        process.exit(34);
    }
    const source = lines.slice(2).join('\n');
    writeFileSync(output, source);
    process.stdout.write(`Recovered ${Buffer.byteLength(source)} bytes to ${output}\n`);
    process.exit(0);
}

if (argv[0] === '--book') {
    const output = argv.findIndex((arg, i) => i > 0 && arg.toLowerCase().endsWith('.pdf'));
    const inputs = argv.slice(1, output);
    const flags = argv.slice(output + 1);
    const text = inputs.map(input => (statSync(input).isDirectory() ? `[folder ${input}]` : readFileSync(input, 'utf8'))).join('\n\\pagebreak\n');
    writeFileSync(argv[output], `${fakePdf(flags, text)}\n/Type /Pages /Kids [] /Count ${inputs.length}\n`);
    if (text.includes('MISSING')) process.stderr.write('Warning: the book: 2 character(s) have no glyph in the fonts found.\n');
    process.exit(0);
}

if (argv[0] !== '--serve' || argv[1] !== '--json') {
    process.stderr.write(`fake rayomd: unsupported command line ${argv.join(' ')}\n`);
    process.exit(2);
}

if (process.env.FAKE_RAYOMD_OLD === '1') {
    // An old rayomd reads "--json" as its output folder and waits for input paths.
    createInterface({ input: process.stdin }).on('line', () => {});
} else {
    if (process.env.FAKE_RAYOMD_START_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_RAYOMD_START_MS));
    process.stdout.write(`${JSON.stringify({ rayomd: '0.0.0-fake', protocol: 1 })}\n`);
    const serveArgs = argv.slice(2);
    createInterface({ input: process.stdin }).on('line', line => {
        if (line === '') return;
        if (line === 'quit' || line === 'exit') process.exit(0);
        const request = JSON.parse(line);
        const markdown = request.markdown ?? readFileSync(request.input, 'utf8');
        if (markdown.includes('CRASH')) {
            process.stderr.write('fake rayomd: crashing as asked\n');
            process.exit(3);
        }
        if (markdown.includes('HANG')) return;
        if (markdown.includes('SLOW')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        if (markdown.includes('GARBAGE')) {
            process.stdout.write('this is not JSON\n');
            return;
        }
        const output = request.output.endsWith('.pdf') ? request.output : `${request.output}.pdf`;
        const pdf = fakePdf([...serveArgs, ...(request.args ?? [])], markdown);
        writeFileSync(output, pdf);
        process.stdout.write(`${JSON.stringify({
            ...(request.id !== undefined ? { id: request.id } : {}),
            input: request.input ?? request.source_path ?? '',
            output,
            status: 'ok',
            code: 0,
            pages: 1,
            bytes: Buffer.byteLength(pdf),
            ms: 0.1,
            missing_characters: markdown.includes('MISSING') ? 2 : 0,
            failed_images: 0,
        })}\n`);
    });
}

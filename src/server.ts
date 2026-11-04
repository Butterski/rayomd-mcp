// The rayomd MCP server: markdown_to_pdf, book_to_pdf, recover_markdown and open_in_gui, and the
// rayomd://syntax resource. Files are read and written only inside the roots (paths.ts); the
// resource flags (URL images, unsafe local images, themes, embedded sources) exist as tool
// options only when the server's own command line allows them.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { resolveRayomd } from './client/binary.js';
import { exportArgs, type ExportOptions } from './client/options.js';
import { runRayomd } from './client/run.js';
import { type RayomdCommand, RayomdPool, type ServeRecord } from './client/serve.js';
import { openInGui } from './gui.js';
import type { Roots } from './paths.js';
import { SYNTAX_SHORT, SYNTAX_URI, syntaxReference } from './syntax.js';

export const SERVER_NAME = 'rayomd-mcp';
const packageJson: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
export const SERVER_VERSION: string =
    packageJson && typeof packageJson === 'object' && 'version' in packageJson && typeof packageJson.version === 'string'
        ? packageJson.version
        : '0.0.0';

/** What the server's command line turns on; each adds a tool option. */
export interface Allowances {
    urlImages?: boolean;
    unsafeLocalImages?: boolean;
    theme?: boolean;
    embedSource?: boolean;
}

export interface RayomdMcpConfig {
    roots: Roots;
    allow?: Allowances;
    /** The rayomd program (default: resolveRayomd(), on first use). */
    rayomd?: RayomdCommand | (() => Promise<RayomdCommand>);
    /** Per-request timeout in milliseconds (default 60000). */
    requestTimeoutMs?: number;
    /** The most rayomd children converting at once (default: one a CPU, at most 4). */
    workers?: number;
    /** Environment for RAYOMD_GUI_PATH, PATH and the display (default process.env). */
    env?: NodeJS.ProcessEnv;
    /** Diagnostics (default stderr). */
    log?: (message: string) => void;
}

const recordSchema = z.object({
    input: z.string().describe('The input path, or the source_path of Markdown text'),
    output: z.string().describe('The PDF written'),
    status: z.enum(['ok', 'error']),
    code: z.number().int().describe('rayomd exit code: 0 ok, 2 bad request, 3 input not readable, 10+N build error, 12 output not writable'),
    error: z.string().optional(),
    pages: z.number().int(),
    bytes: z.number().int(),
    ms: z.number().describe('Build time in milliseconds'),
    missing_characters: z.number().int().describe('Characters without a glyph in the fonts found (drawn as a base letter or ?)'),
    failed_images: z.number().int().describe('Images that could not be loaded (their alt text is printed)'),
});

const bookRecordSchema = z.object({
    inputs: z.array(z.string()),
    output: z.string(),
    status: z.literal('ok'),
    code: z.literal(0),
    pages: z.number().int(),
    bytes: z.number().int(),
    ms: z.number(),
    missing_characters: z.number().int(),
});

const recoverSchema = z.object({
    input: z.string().describe('The PDF read'),
    output: z.string().optional().describe('The Markdown file written, when output was given'),
    bytes: z.number().int().describe('Bytes of Markdown recovered'),
    markdown: z.string().optional().describe('The recovered Markdown, when no output was given'),
});

const guiSchema = z.object({
    gui: z.string().describe('The RayoMD GUI executable started'),
    file: z.string(),
    pid: z.number().int().optional(),
});

function optionsShape(allow: Allowances, book: boolean) {
    const level = z.number().int().min(1).max(6);
    return {
        style: z.enum(['elegant', 'modern', 'tech']).optional().describe('Look of the document (default elegant)'),
        margin: z.string().regex(/^(compact|normal|wide|margin=(\d+(\.\d*)?|\.\d+)(in|pt)?)$/i).optional()
            .describe('compact, normal (default), wide, or margin=N in inches or margin=Npt: margin=0.75in, margin=54pt'),
        page_size: z.string().regex(/^[a-z0-9.\-]{2,40}$/i).optional()
            .describe('a4 (default), a3, a5, letter or legal, each also with -landscape; WIDTHxHEIGHT in mm, cm, in or pt (210x297mm); or WIDTHxauto (210mmxauto: one long page)'),
        toc: z.boolean().optional().describe(book ? 'One table of contents for the whole book' : 'A table of contents first, or at a [TOC] paragraph'),
        toc_depth: level.optional().describe('Heading levels the table of contents lists (default 3)'),
        number_headings: level.optional().describe('Number the headings of this many levels: 1, 1.1, 1.1.1'),
        page_numbers: z.boolean().optional().describe('"N / M" at the foot of every page'),
        footnotes: z.enum(['end', 'page']).optional().describe('end (default): after the text; page: at the foot of the page of the first reference'),
        dialect: z.enum(['github', 'obsidian']).optional()
            .describe('github (default), or obsidian: callouts, ==highlights==, %%comments%%, [[wiki links]], ![[embeds]]'),
        pdfa: z.boolean().optional().describe('PDF/A-3b: every font embedded'),
        pdfua: z.boolean().optional().describe('PDF/UA-1, tagged for screen readers (formulas as TeX source)'),
        black_text: z.boolean().optional().describe('For black-and-white printers: text, links and code black, fills light grey'),
        highlight_code: z.boolean().optional().describe('Colour fenced code by language (default true)'),
        diagrams: z.boolean().optional().describe('Draw ```mermaid flowcharts, sequence diagrams and pie charts (default true)'),
        page_break_before: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']).optional()
            .describe('A new page before each heading of level 1 to N (h1: chapters)'),
        ...(allow.urlImages ? { allow_url_images: z.boolean().optional().describe('Load http(s) images') } : {}),
        ...(allow.unsafeLocalImages
            ? { allow_unsafe_local_images: z.boolean().optional().describe('Load local images from outside the Markdown file\'s folder') }
            : {}),
        ...(allow.theme ? { theme: z.string().optional().describe('Path of a theme file (key = value lines) inside the allowed folders') } : {}),
        ...(allow.embedSource && !book
            ? { embed_source: z.boolean().optional().describe('Embed the Markdown in the PDF, so recover_markdown can get it back') }
            : {}),
    };
}

type ToolResult = {
    content: Array<
        | { type: 'text'; text: string }
        | { type: 'resource_link'; uri: string; name: string; mimeType: string; description?: string }
    >;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};

function failure(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function pdfLink(file: string): ToolResult['content'][number] {
    return { type: 'resource_link', uri: pathToFileURL(file).href, name: path.basename(file), mimeType: 'application/pdf' };
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function summary(output: string, pages: number, bytes: number, ms: number, missing: number, failedImages?: number): string {
    let text = `Wrote ${output}: ${plural(pages, 'page')}, ${bytes} bytes, ${ms.toFixed(3)} ms`;
    if (missing > 0) text += `; ${plural(missing, 'character')} without a glyph (install a font that has them or set RAYOMD_FONT)`;
    if (failedImages) text += `; ${plural(failedImages, 'image')} not loaded (alt text printed)`;
    return `${text}.`;
}

/** The first message of rayomd's stderr, without "Error: " and the usage text after it. */
function rayomdError(stderr: string, code: number | null): string {
    const first = stderr.split(/\r?\n\r?\n/)[0]!.trim().replace(/^Error: /, '');
    return `${first || 'rayomd failed'} (exit code ${code ?? 'none'})`;
}

/** Pages of a PDF: the largest /Count of its page tree nodes. */
export function pdfPageCount(pdf: Buffer): number {
    let pages = 0;
    for (const match of pdf.toString('latin1').matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) pages = Math.max(pages, Number(match[1]));
    return pages;
}

/** One rayomd-mcp server process: the roots, the warm serve children and the MCP server factory. */
export class RayomdMcp {
    readonly roots: Roots;
    readonly serve: RayomdPool;
    private readonly config: RayomdMcpConfig;
    private readonly allow: Allowances;
    private command?: Promise<RayomdCommand>;

    constructor(config: RayomdMcpConfig) {
        this.config = config;
        this.roots = config.roots;
        this.allow = config.allow ?? {};
        this.serve = new RayomdPool({ command: () => this.rayomd(), requestTimeoutMs: config.requestTimeoutMs, maxChildren: config.workers });
    }

    private log(message: string): void {
        (this.config.log ?? (line => process.stderr.write(`rayomd-mcp: ${line}\n`)))(message);
    }

    /** The rayomd program, resolved once; a failed resolution (no network) is tried again next time. */
    private rayomd(): Promise<RayomdCommand> {
        const configured = this.config.rayomd;
        if (configured && typeof configured !== 'function') return Promise.resolve(configured);
        this.command ??= (configured ? configured() : resolveRayomd({ env: this.config.env, log: message => this.log(message) })
            .then(binary => ({ command: binary.path })));
        this.command.catch(() => {
            this.command = undefined;
        });
        return this.command;
    }

    /**
     * Starts the first rayomd child before the first call (2026-11-04: the first tester.md call
     * took 34.6 ms, the second 4.9). Only with a binary already here: a download waits for the
     * first call, which reports its progress and its failure.
     */
    warm(): void {
        if (this.config.rayomd !== undefined || this.command !== undefined) {
            this.serve.warm();
            return;
        }
        resolveRayomd({ env: this.config.env, offline: true }).then(binary => {
            this.command ??= Promise.resolve({ command: binary.path });
            this.serve.warm();
        }, () => {});
    }

    /** The export flags of a tool call's options, the theme path checked against the roots. */
    private async flags(options: ExportOptions): Promise<string[]> {
        const checked: ExportOptions = { ...options };
        if (!this.allow.urlImages) delete checked.allow_url_images;
        if (!this.allow.unsafeLocalImages) delete checked.allow_unsafe_local_images;
        if (!this.allow.embedSource) delete checked.embed_source;
        if (!this.allow.theme) delete checked.theme;
        if (checked.theme !== undefined) checked.theme = await this.roots.existing(checked.theme, 'theme');
        return exportArgs(checked);
    }

    private instructions(): string {
        return 'RayoMD turns Markdown into PDF natively (no browser or TeX), the same PDF on every run. ' +
            `Files are read and written only inside: ${this.roots.dirs.join(', ')}; relative paths resolve from ${this.roots.dirs[0]}. ` +
            `Read ${SYNTAX_URI} for what renders before writing complex Markdown.`;
    }

    /** A new MCP server instance on this process's roots and rayomd child (a serveStdio factory). */
    createServer(): McpServer {
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: this.instructions() });
        this.registerMarkdownToPdf(server);
        this.registerBookToPdf(server);
        this.registerRecoverMarkdown(server);
        this.registerOpenInGui(server);
        server.registerResource(
            'syntax',
            SYNTAX_URI,
            {
                title: 'RayoMD Markdown syntax',
                description: 'What RayoMD renders (GitHub Markdown, alerts, footnotes, math, Mermaid, code colours) and what degrades',
                mimeType: 'text/markdown',
            },
            async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: syntaxReference() }] }),
        );
        return server;
    }

    private registerMarkdownToPdf(server: McpServer): void {
        const inputSchema = z.object({
            markdown: z.string().optional().describe('The Markdown text (give this or path)'),
            path: z.string().optional().describe('A Markdown file to convert (give this or markdown)'),
            output: z.string().describe('The PDF to write, ending in .pdf; an existing file is replaced'),
            source_path: z.string().optional()
                .describe('With markdown: the .md file the text stands for; relative images resolve from its folder. Default: output with .md'),
            ...optionsShape(this.allow, false),
        });
        server.registerTool(
            'markdown_to_pdf',
            {
                title: 'Markdown to PDF',
                description: `Converts Markdown (text or a file) to a PDF with RayoMD and returns the PDF's page count and warnings. ${SYNTAX_SHORT}`,
                inputSchema,
                outputSchema: recordSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
            async args => {
                const { markdown, path: input, output, source_path: sourcePath, ...options } = args as z.infer<typeof inputSchema> & ExportOptions;
                if ((markdown === undefined) === (input === undefined)) return failure('Give exactly one of markdown and path.');
                if (input !== undefined && sourcePath !== undefined) return failure('source_path applies to markdown text only.');
                let request;
                try {
                    const target = await this.roots.output(output, 'output', '.pdf');
                    const flags = await this.flags(options);
                    if (input !== undefined) {
                        request = { input: await this.roots.existing(input, 'path'), output: target, args: flags };
                    } else {
                        // The default source is the output's name with .md, in the folder just checked;
                        // rayomd only resolves images from it and never opens it.
                        const source = sourcePath === undefined
                            ? target.replace(/\.pdf$/, '.md')
                            : await this.roots.output(sourcePath, 'source_path', '.md');
                        request = { markdown: markdown!, source_path: source, output: target, args: flags };
                    }
                } catch (error) {
                    return failure((error as Error).message);
                }
                let record: ServeRecord;
                try {
                    record = await this.serve.request(request);
                } catch (error) {
                    return failure(`${(error as Error).message} The next request starts rayomd again.`);
                }
                const { id: _id, ...structured } = record;
                if (record.status !== 'ok') return failure(`rayomd: ${record.error ?? 'export failed'} (code ${record.code})`);
                return {
                    content: [
                        { type: 'text', text: summary(record.output, record.pages, record.bytes, record.ms, record.missing_characters, record.failed_images) },
                        pdfLink(record.output),
                    ],
                    structuredContent: structured,
                };
            },
        );
    }

    private registerBookToPdf(server: McpServer): void {
        const inputSchema = z.object({
            inputs: z.array(z.string()).min(1)
                .describe('One SUMMARY.md (mdBook, GitBook), one folder (its SUMMARY.md, or its .md files by name, README.md first), or Markdown files in order'),
            output: z.string().describe('The PDF to write, ending in .pdf; an existing file is replaced'),
            ...optionsShape(this.allow, true),
        });
        server.registerTool(
            'book_to_pdf',
            {
                title: 'Book to PDF',
                description: 'Makes one PDF of several Markdown files: each from a new page, links between them kept, one outline ' +
                    '(and with toc one table of contents). The files a SUMMARY.md lists or a folder holds must lie in that folder.',
                inputSchema,
                outputSchema: bookRecordSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
            async args => {
                const { inputs, output, ...options } = args as z.infer<typeof inputSchema> & ExportOptions;
                let argv: string[];
                let target: string;
                const realInputs: string[] = [];
                try {
                    target = await this.roots.output(output, 'output', '.pdf');
                    for (const input of inputs) {
                        const real = await this.roots.existing(input, 'inputs', { folder: true });
                        // rayomd --book takes the first argument ending in .pdf for the output.
                        if (real.toLowerCase().endsWith('.pdf')) throw new Error(`inputs: ${input} is a PDF, not Markdown`);
                        realInputs.push(real);
                    }
                    argv = ['--book', ...realInputs, target, ...(await this.flags(options))];
                } catch (error) {
                    return failure((error as Error).message);
                }
                let result;
                const started = performance.now();
                try {
                    result = await runRayomd(await this.rayomd(), argv, this.config.requestTimeoutMs);
                } catch (error) {
                    return failure((error as Error).message);
                }
                const ms = performance.now() - started;
                if (result.timedOut) return failure('rayomd --book did not finish in time and was stopped.');
                if (result.code !== 0) return failure(`rayomd: ${rayomdError(result.stderr, result.code)}`);
                const pdf = await readFile(target);
                const missing = Number(/(\d+) character\(s\) have no glyph/.exec(result.stderr)?.[1] ?? 0);
                const record = { inputs: realInputs, output: target, status: 'ok' as const, code: 0 as const, pages: pdfPageCount(pdf),
                    bytes: (await stat(target)).size, ms: Math.round(ms * 1000) / 1000, missing_characters: missing };
                return {
                    content: [{ type: 'text', text: summary(target, record.pages, record.bytes, record.ms, missing) }, pdfLink(target)],
                    structuredContent: record,
                };
            },
        );
    }

    private registerRecoverMarkdown(server: McpServer): void {
        const inputSchema = z.object({
            pdf: z.string().describe('A PDF exported with the source embedded (rayomd --embed-source)'),
            output: z.string().optional()
                .describe('A new .md file to write the source to (never replaces a file); left out, the Markdown is returned as text'),
        });
        server.registerTool(
            'recover_markdown',
            {
                title: 'Recover Markdown from a PDF',
                description: 'Gets back the exact Markdown source of a reversible PDF (one exported with the source embedded), ' +
                    'checked against its digest. Returns the text, or writes it to a new .md file; the PDF is not changed.',
                inputSchema,
                outputSchema: recoverSchema,
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            },
            async ({ pdf, output }) => {
                let input: string;
                let target: string | undefined;
                try {
                    input = await this.roots.existing(pdf, 'pdf', { extension: '.pdf' });
                    if (output !== undefined) target = await this.roots.output(output, 'output', '.md', { mustNotExist: true });
                } catch (error) {
                    return failure((error as Error).message);
                }
                const scratch = target === undefined ? await mkdtemp(path.join(tmpdir(), 'rayomd-mcp-')) : undefined;
                try {
                    const destination = target ?? path.join(scratch!, 'source.md');
                    const result = await runRayomd(await this.rayomd(), ['--recover-source', input, destination], this.config.requestTimeoutMs);
                    if (result.timedOut) return failure('rayomd --recover-source did not finish in time and was stopped.');
                    if (result.code !== 0) return failure(`rayomd: ${rayomdError(result.stderr, result.code)}`);
                    const text = await readFile(destination, 'utf8');
                    const bytes = Buffer.byteLength(text, 'utf8');
                    if (target !== undefined) {
                        return {
                            content: [
                                { type: 'text', text: `Recovered ${bytes} bytes of Markdown from ${input} to ${target}.` },
                                { type: 'resource_link', uri: pathToFileURL(target).href, name: path.basename(target), mimeType: 'text/markdown' },
                            ],
                            structuredContent: { input, output: target, bytes },
                        };
                    }
                    return { content: [{ type: 'text', text }], structuredContent: { input, bytes, markdown: text } };
                } catch (error) {
                    return failure((error as Error).message);
                } finally {
                    if (scratch) await rm(scratch, { recursive: true, force: true });
                }
            },
        );
    }

    private registerOpenInGui(server: McpServer): void {
        server.registerTool(
            'open_in_gui',
            {
                title: 'Open in RayoMD GUI',
                description: 'Opens a Markdown file in RayoMD GUI, the desktop editor with a live PDF preview, for the user to read ' +
                    'or edit. The GUI checks the file about once a second, focused or not, and reloads it when it changed on disk ' +
                    'and its buffer has no unsaved edits, so a file the agent rewrites shows the new version. Needs RayoMD GUI ' +
                    'installed (rayomd-gui on PATH or RAYOMD_GUI_PATH) and a desktop session (Wayland on Linux).',
                inputSchema: z.object({ path: z.string().describe('The .md file to open') }),
                outputSchema: guiSchema,
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            },
            async ({ path: file }) => {
                try {
                    const real = await this.roots.existing(file, 'path', { extension: '.md' });
                    const launch = await openInGui(real, this.config.env);
                    return {
                        content: [{ type: 'text', text: `Opened ${real} in RayoMD GUI.` }],
                        structuredContent: { gui: launch.gui, file: launch.file, ...(launch.pid !== undefined ? { pid: launch.pid } : {}) },
                    };
                } catch (error) {
                    return failure((error as Error).message);
                }
            },
        );
    }

    /** Ends the rayomd children. */
    close(): Promise<void> {
        return this.serve.close();
    }
}

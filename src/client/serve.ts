// A client of `rayomd --serve --json` (protocol 1): one warm child process, requests sent one at
// a time and answered in order. A child that exits, writes something unexpected or does not
// answer within the request timeout fails that request and is stopped; the next request starts a
// new child. RayomdPool spreads requests that come at the same time over several such children.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

/** A program to run: rayomd itself, or an interpreter and a script for tests. */
export interface RayomdCommand {
    command: string;
    /** Arguments before rayomd's own (default none). */
    args?: string[];
}

/** One request of the protocol, without `id` (the client numbers requests itself). */
export type ServeRequest = (
    | { input: string; markdown?: undefined; source_path?: undefined }
    | { markdown: string; source_path?: string; input?: undefined }
) & {
    output: string;
    /** The CLI's export flags for this request. */
    args?: string[];
};

/** The answer to a request: rayomd's --report record. */
export interface ServeRecord {
    id?: string | number;
    input: string;
    output: string;
    status: 'ok' | 'error';
    code: number;
    error?: string;
    pages: number;
    bytes: number;
    ms: number;
    missing_characters: number;
    failed_images: number;
}

export interface ServeGreeting {
    rayomd: string;
    protocol: number;
}

export interface RayomdServeOptions {
    /** The program to start, or a function resolving it on first use (such as resolveRayomd). */
    command: RayomdCommand | (() => Promise<RayomdCommand>);
    /** Options of the serve command line, which every request starts from (default none). */
    serveArgs?: string[];
    /** Milliseconds a request may take before the child is stopped (default 60000). */
    requestTimeoutMs?: number;
    /** Milliseconds the child may take to print its greeting (default 10000). */
    startTimeoutMs?: number;
}

/** The longest request line rayomd accepts, without its line break. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;

class ServeError extends Error {}

interface Child {
    process: ChildProcessWithoutNullStreams;
    greeting?: ServeGreeting;
    /** Complete stdout lines not yet read. */
    lines: string[];
    partial: string;
    waiter?: { resolve: (line: string) => void; reject: (error: Error) => void };
    exited: boolean;
    exitDescription: string;
    stderr: string;
}

function startChild(command: RayomdCommand, serveArgs: string[]): Child {
    const proc = spawn(command.command, [...(command.args ?? []), '--serve', '--json', ...serveArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
    });
    const child: Child = { process: proc, lines: [], partial: '', exited: false, exitDescription: '', stderr: '' };
    const fail = (error: Error) => {
        const waiter = child.waiter;
        child.waiter = undefined;
        waiter?.reject(error);
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
        const parts = (child.partial + chunk).split('\n');
        child.partial = parts.pop() ?? '';
        for (const part of parts) child.lines.push(part.endsWith('\r') ? part.slice(0, -1) : part);
        const waiter = child.waiter;
        if (waiter && child.lines.length > 0) {
            child.waiter = undefined;
            waiter.resolve(child.lines.shift()!);
        }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
        child.stderr = (child.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // A write to a child that has gone surfaces as its exit, below.
    proc.stdin.on('error', () => {});
    proc.on('error', error => {
        child.exited = true;
        child.exitDescription = `could not be started: ${error.message}`;
        fail(new ServeError(`rayomd (${command.command}) ${child.exitDescription}`));
    });
    proc.on('close', (code, signal) => {
        child.exited = true;
        child.exitDescription = signal ? `was ended by ${signal}` : `exited with code ${code}`;
        const stderr = child.stderr.trim();
        fail(new ServeError(`rayomd ${child.exitDescription}${stderr ? `: ${stderr}` : ''}`));
    });
    return child;
}

function nextLine(child: Child, timeoutMs: number, what: string): Promise<string> {
    if (child.lines.length > 0) return Promise.resolve(child.lines.shift()!);
    if (child.exited) return Promise.reject(new ServeError(`rayomd ${child.exitDescription}`));
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
        child.waiter = undefined;
        reject(new ServeError(`rayomd did not answer ${what} within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.waiter = {
        resolve: line => {
            clearTimeout(timer);
            resolve(line);
        },
        reject: error => {
            clearTimeout(timer);
            reject(error);
        },
    };
    return promise;
}

const NUMBER_FIELDS = ['code', 'pages', 'bytes', 'ms', 'missing_characters', 'failed_images'] as const;

/** Whether `value` has the shape of a --report record. */
export function isServeRecord(value: unknown): value is ServeRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return typeof record.input === 'string' && typeof record.output === 'string' &&
        (record.status === 'ok' || record.status === 'error') &&
        (record.error === undefined || typeof record.error === 'string') &&
        (record.id === undefined || typeof record.id === 'string' || typeof record.id === 'number') &&
        NUMBER_FIELDS.every(field => typeof record[field] === 'number');
}

/** One warm `rayomd --serve --json` child with a queue of requests. */
export class RayomdServe {
    private readonly options: RayomdServeOptions;
    private child?: Child;
    private tail: Promise<unknown> = Promise.resolve();
    private nextId = 1;
    private closed = false;

    constructor(options: RayomdServeOptions) {
        this.options = options;
    }

    /** The greeting of the running child, if one is running. */
    get greeting(): ServeGreeting | undefined {
        return this.child?.greeting;
    }

    /** The process id of the running child, if one is running. */
    get pid(): number | undefined {
        return this.child && !this.child.exited ? this.child.process.pid : undefined;
    }

    /**
     * Sends `request` after the requests before it have been answered and resolves with rayomd's
     * record (`status` "ok" or "error"). Rejects when the child could not start, exited, broke
     * the protocol or timed out; the next request then starts a new child.
     */
    request(request: ServeRequest): Promise<ServeRecord> {
        const result = this.tail.then(() => this.send(request));
        this.tail = result.catch(() => {});
        return result;
    }

    /**
     * Starts the child ahead of the first request, so that request does not wait for its start.
     * A failure is left to the next request, which starts the child again and reports it.
     */
    warm(): void {
        if (this.closed) return;
        const started = this.tail.then(() => this.start());
        this.tail = started.catch(() => {});
    }

    private async start(): Promise<Child> {
        if (this.child && !this.child.exited) return this.child;
        if (this.closed) throw new Error('The rayomd client is closed.');
        const command = typeof this.options.command === 'function' ? await this.options.command() : this.options.command;
        const child = startChild(command, this.options.serveArgs ?? []);
        this.child = child;
        try {
            const line = await nextLine(child, this.options.startTimeoutMs ?? 10_000, 'with a greeting');
            let greeting: unknown;
            try {
                greeting = JSON.parse(line);
            } catch {
                greeting = undefined;
            }
            if (!greeting || typeof greeting !== 'object' || !('rayomd' in greeting) || typeof greeting.rayomd !== 'string' ||
                !('protocol' in greeting) || greeting.protocol !== 1) {
                throw new ServeError(`rayomd (${command.command}) does not speak the --serve --json protocol 1 ` +
                    `(first line: ${JSON.stringify(line.slice(0, 200))}); install a RayoMD release with --serve --json.`);
            }
            child.greeting = { rayomd: greeting.rayomd, protocol: 1 };
            return child;
        } catch (error) {
            this.stop(child);
            if (error instanceof ServeError && !child.greeting && /did not answer/.test(error.message)) {
                throw new ServeError(`${error.message}; ${command.command} may be a RayoMD without --serve --json.`);
            }
            throw error;
        }
    }

    private async send(request: ServeRequest): Promise<ServeRecord> {
        if (this.closed) throw new Error('The rayomd client is closed.');
        const id = this.nextId++;
        const line = JSON.stringify({ id, ...request });
        // A UTF-16 code unit is at most 3 UTF-8 bytes: only a line that long can be over the limit.
        if (line.length * 3 > MAX_REQUEST_BYTES && Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
            throw new Error(`The request is larger than rayomd's limit of ${MAX_REQUEST_BYTES} bytes.`);
        }
        const child = await this.start();
        child.process.stdin.write(`${line}\n`);
        try {
            const answer = await nextLine(child, this.options.requestTimeoutMs ?? 60_000, 'the request');
            let record: unknown;
            try {
                record = JSON.parse(answer);
            } catch {
                throw new ServeError(`rayomd answered with a line that is not JSON: ${JSON.stringify(answer.slice(0, 200))}`);
            }
            if (!isServeRecord(record)) throw new ServeError(`rayomd answered with an unexpected record: ${answer.slice(0, 200)}`);
            if (record.id !== id) throw new ServeError(`rayomd answered request ${JSON.stringify(record.id)} where ${id} was expected`);
            return record;
        } catch (error) {
            this.stop(child);
            throw error;
        }
    }

    private stop(child: Child): void {
        if (this.child === child) this.child = undefined;
        if (!child.exited) child.process.kill('SIGKILL');
    }

    /** Stops the child at once (for process exit handlers). */
    kill(): void {
        this.closed = true;
        if (this.child) this.stop(this.child);
    }

    /** Ends the session: `quit` to the child, killed when it has not exited after `graceMs`. */
    async close(graceMs = 2000): Promise<void> {
        this.closed = true;
        const child = this.child;
        this.child = undefined;
        if (!child || child.exited) return;
        const exited = Promise.withResolvers<void>();
        child.process.once('close', () => exited.resolve());
        child.process.stdin.end('quit\n');
        const timer = setTimeout(() => child.process.kill('SIGKILL'), graceMs);
        await exited.promise;
        clearTimeout(timer);
    }
}

export interface RayomdPoolOptions extends RayomdServeOptions {
    /** The most children running at once (default: one a CPU, at most 4). */
    maxChildren?: number;
}

interface PoolChild {
    serve: RayomdServe;
    pending: number;
}

/**
 * RayomdServe children for requests that overlap: a request goes to an idle child, else to a new
 * one while fewer than `maxChildren` run, else to the child with the fewest waiting. Requests for
 * one output path stay on one child, so they are written in the order they came. A child starts on
 * the first request that finds none idle; a single caller never starts a second.
 */
export class RayomdPool {
    private readonly options: RayomdServeOptions;
    private readonly maxChildren: number;
    private readonly children: PoolChild[] = [];
    /** The child with requests for an output path, and how many. */
    private readonly outputs = new Map<string, { child: PoolChild; pending: number }>();
    private closed = false;

    constructor(options: RayomdPoolOptions) {
        this.options = options;
        this.maxChildren = Math.max(1, options.maxChildren ?? Math.min(4, availableParallelism()));
    }

    /** The greeting of the first child, if it runs. */
    get greeting(): ServeGreeting | undefined {
        return this.children[0]?.serve.greeting;
    }

    /** The process id of the first child, if it runs. */
    get pid(): number | undefined {
        return this.children[0]?.serve.pid;
    }

    /** Starts the first child ahead of the first request (RayomdServe.warm). */
    warm(): void {
        if (this.closed) return;
        if (this.children.length === 0) this.children.push({ serve: new RayomdServe(this.options), pending: 0 });
        this.children[0]!.serve.warm();
    }

    /** As RayomdServe.request, on the child chosen for it. */
    request(request: ServeRequest): Promise<ServeRecord> {
        if (this.closed) return Promise.reject(new Error('The rayomd client is closed.'));
        const owner = this.outputs.get(request.output);
        let child = owner?.child ?? this.children.find(candidate => candidate.pending === 0);
        if (!child && this.children.length < this.maxChildren) {
            child = { serve: new RayomdServe(this.options), pending: 0 };
            this.children.push(child);
        }
        child ??= this.children.reduce((fewest, candidate) => (candidate.pending < fewest.pending ? candidate : fewest));
        const chosen = child;
        chosen.pending++;
        if (owner) owner.pending++;
        else this.outputs.set(request.output, { child: chosen, pending: 1 });
        const result = chosen.serve.request(request);
        const done = () => {
            chosen.pending--;
            const entry = this.outputs.get(request.output);
            if (entry && --entry.pending === 0) this.outputs.delete(request.output);
        };
        result.then(done, done);
        return result;
    }

    /** Stops every child at once. */
    kill(): void {
        this.closed = true;
        for (const child of this.children) child.serve.kill();
    }

    /** Ends every child's session (RayomdServe.close). */
    async close(graceMs = 2000): Promise<void> {
        this.closed = true;
        await Promise.all(this.children.map(child => child.serve.close(graceMs)));
    }
}

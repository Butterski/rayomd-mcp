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
     * Starts the child ahead of the first request and resolves once it has greeted, or rejects
     * with why it could not start; a later request starts it again.
     */
    ready(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('The rayomd client is closed.'));
        const started = this.tail.then(() => this.start());
        this.tail = started.catch(() => {});
        return started.then(() => {});
    }

    /** ready() without waiting for it: a failure is left to the next request, which reports it. */
    warm(): void {
        this.ready().catch(() => {});
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
    /** The most rayomd processes working at once (default: one a CPU, at most 4). */
    maxChildren?: number;
    /** Milliseconds a child beyond the first may stay idle before it is ended (default 30000). */
    idleMs?: number;
    /**
     * Milliseconds calls may wait for busy children, without a break, before another child starts
     * (default 5): starting one holds Node's event loop about 0.75 ms (spawn), and a warm child
     * clears a burst of small calls sooner than that.
     */
    startAfterMs?: number;
}

export interface PoolCallOptions {
    /** Cancels the call while it waits for a child; one already sent runs to its end. */
    signal?: AbortSignal;
}

interface Worker {
    serve: RayomdServe;
    ready: boolean;
    busy: boolean;
    idleSince: number;
}

type Job = {
    resolve: (value: never) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
    queuedAt: number;
} & (
    | { kind: 'serve'; request: ServeRequest }
    | { kind: 'run'; run: (signal?: AbortSignal) => Promise<unknown> }
);

/** After a child failed to start, the next start waits this long if another child serves. */
const START_RETRY_MS = 1000;

/**
 * Warm `rayomd --serve --json` children and one queue of calls, in their order:
 *
 * - A call goes to the first idle child that has greeted. None idle: it waits in the queue. When
 *   calls have waited `startAfterMs` without a break, one more child starts (up to
 *   `maxChildren`, one at a time): a burst of small calls is cleared by the warm child without new
 *   processes, a steady load gets its children, and a waiting call goes to whichever child is
 *   free first, never to one still starting.
 * - Calls for one output path run one after the other, in their order.
 * - `run` takes a slot for a one-shot rayomd command (--book, --recover-source): with the busy
 *   children, at most `maxChildren` rayomd processes work at once.
 * - A child that died or broke the protocol is dropped after its call; a call that waits is
 *   cancelled through its signal. Children beyond the first end after `idleMs` idle.
 */
export class RayomdPool {
    private readonly options: RayomdServeOptions;
    private readonly maxChildren: number;
    private readonly idleMs: number;
    private readonly startAfterMs: number;
    private startTimer?: NodeJS.Timeout;
    private backlogSince?: number;
    private reaper?: NodeJS.Timeout;
    private busy = 0;
    private readonly workers: Worker[] = [];
    private readonly queue: Job[] = [];
    private readonly busyOutputs = new Set<string>();
    private running = 0;
    private startBlockedUntil = 0;
    private closed = false;

    constructor(options: RayomdPoolOptions) {
        this.options = options;
        this.maxChildren = Math.max(1, options.maxChildren ?? Math.min(4, availableParallelism()));
        this.idleMs = options.idleMs ?? 30_000;
        this.startAfterMs = options.startAfterMs ?? 5;
    }

    /** The greeting of the first child that has greeted. */
    get greeting(): ServeGreeting | undefined {
        return this.workers.find(worker => worker.ready)?.serve.greeting;
    }

    /** The process id of the first running child. */
    get pid(): number | undefined {
        for (const worker of this.workers) if (worker.serve.pid !== undefined) return worker.serve.pid;
        return undefined;
    }

    /** The children running or starting. */
    get children(): number {
        return this.workers.length;
    }

    /** Starts the first child ahead of the first call. */
    warm(): void {
        if (!this.closed && this.workers.length === 0) this.spawn();
    }

    /** As RayomdServe.request, on the first child free for it. */
    request(request: ServeRequest, options: PoolCallOptions = {}): Promise<ServeRecord> {
        return this.enqueue<ServeRecord>({ kind: 'serve', request }, options.signal);
    }

    /**
     * Runs `run` (a one-shot rayomd command) when a slot is free; `signal` is the call's, aborted
     * when it is cancelled while running too.
     */
    run<T>(run: (signal?: AbortSignal) => Promise<T>, options: PoolCallOptions = {}): Promise<T> {
        return this.enqueue<T>({ kind: 'run', run }, options.signal);
    }

    private enqueue<T>(work: { kind: 'serve'; request: ServeRequest } | { kind: 'run'; run: (signal?: AbortSignal) => Promise<unknown> },
        signal: AbortSignal | undefined): Promise<T> {
        if (this.closed) return Promise.reject(new Error('The rayomd client is closed.'));
        if (signal?.aborted) return Promise.reject(new Error('The call was cancelled.'));
        const { promise, resolve, reject } = Promise.withResolvers<T>();
        const job = { ...work, resolve, reject, signal, queuedAt: performance.now() } as Job;
        if (signal) {
            job.onAbort = () => {
                const at = this.queue.indexOf(job);
                if (at < 0) return;
                this.queue.splice(at, 1);
                job.reject(new Error('The call was cancelled.'));
            };
            signal.addEventListener('abort', job.onAbort, { once: true });
        }
        this.queue.push(job);
        this.pump();
        return promise;
    }

    private get active(): number {
        return this.running + this.busy;
    }

    /** Hands out what can start now, then starts a child when a call has waited long enough. */
    private pump(): void {
        if (this.closed) return;
        let active = this.active;
        let oldestWaiting = Infinity;
        for (let at = 0; at < this.queue.length && active < this.maxChildren;) {
            const job = this.queue[at]!;
            if (job.kind === 'run') {
                this.queue.splice(at, 1);
                this.startRun(job);
                active++;
                continue;
            }
            if (this.busyOutputs.has(job.request.output)) {
                at++;
                continue;
            }
            const worker = this.workers.find(candidate => candidate.ready && !candidate.busy);
            if (!worker) {
                oldestWaiting = Math.min(oldestWaiting, job.queuedAt);
                at++;
                continue;
            }
            this.queue.splice(at, 1);
            this.dispatch(worker, job);
            active++;
        }
        // How long calls have waited for a child without a break: a burst the warm children clear
        // does not count, a busy stretch does, however short each call is.
        if (oldestWaiting === Infinity) {
            this.backlogSince = undefined;
            return;
        }
        this.backlogSince ??= oldestWaiting;
        if (this.workers.length >= this.maxChildren) return;
        // One child starting at a time.
        if (this.workers.some(worker => !worker.ready)) return;
        // No child at all: start one now. Else once calls have waited startAfterMs without a
        // break, and not within START_RETRY_MS of a child that failed to start.
        const due = this.workers.length === 0 ? 0 : Math.max(this.backlogSince + this.startAfterMs, this.startBlockedUntil);
        const wait = due - performance.now();
        if (wait <= 0) {
            this.spawn();
        } else if (!this.startTimer) {
            this.startTimer = setTimeout(() => {
                this.startTimer = undefined;
                this.pump();
            }, Math.ceil(wait));
            this.startTimer.unref();
        }
    }

    private detach(job: Job): void {
        if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    }

    private dispatch(worker: Worker, job: Job & { kind: 'serve' }): void {
        this.detach(job);
        worker.busy = true;
        this.busy++;
        const output = job.request.output;
        this.busyOutputs.add(output);
        const settle = () => {
            worker.busy = false;
            this.busy--;
            this.busyOutputs.delete(output);
            // A child that died, timed out or broke the protocol was stopped: drop it, and let a
            // new one start when calls wait.
            if (worker.serve.pid === undefined) this.remove(worker);
            else this.idle(worker);
            this.pump();
        };
        worker.serve.request(job.request).then(record => {
            settle();
            (job.resolve as (record: ServeRecord) => void)(record);
        }, (error: Error) => {
            settle();
            job.reject(error);
        });
    }

    private startRun(job: Job & { kind: 'run' }): void {
        this.running++;
        job.run(job.signal).then(job.resolve as (value: unknown) => void, job.reject).finally(() => {
            this.detach(job);
            this.running--;
            this.pump();
        });
    }

    private spawn(): void {
        const worker: Worker = { serve: new RayomdServe(this.options), ready: false, busy: false, idleSince: 0 };
        this.workers.push(worker);
        worker.serve.ready().then(() => {
            worker.ready = true;
            this.idle(worker);
            this.pump();
        }, (error: Error) => {
            this.remove(worker);
            this.startBlockedUntil = performance.now() + START_RETRY_MS;
            // No other child running or starting: the calls waiting for one fail with the reason.
            if (this.workers.length === 0) {
                for (let at = 0; at < this.queue.length;) {
                    const job = this.queue[at]!;
                    if (job.kind !== 'serve') {
                        at++;
                        continue;
                    }
                    this.queue.splice(at, 1);
                    this.detach(job);
                    job.reject(error);
                }
            }
            this.pump();
        });
    }

    /**
     * Notes when a child became idle. One timer, armed while children beyond the first exist,
     * ends those idle for idleMs: a timer a call cost more than the call's own bookkeeping.
     */
    private idle(worker: Worker): void {
        worker.idleSince = performance.now();
        if (this.reaper || this.workers.length < 2) return;
        this.reaper = setInterval(() => this.reap(), Math.max(10, this.idleMs / 2));
        this.reaper.unref();
    }

    private reap(): void {
        const now = performance.now();
        for (const worker of this.workers.slice(1)) {
            if (worker.ready && !worker.busy && now - worker.idleSince >= this.idleMs) {
                this.remove(worker);
                void worker.serve.close();
            }
        }
        if (this.workers.length < 2) {
            clearInterval(this.reaper);
            this.reaper = undefined;
        }
    }

    private remove(worker: Worker): void {
        const at = this.workers.indexOf(worker);
        if (at >= 0) this.workers.splice(at, 1);
    }

    private failQueued(): void {
        clearTimeout(this.startTimer);
        clearInterval(this.reaper);
        for (const job of this.queue.splice(0)) {
            this.detach(job);
            job.reject(new Error('The rayomd client is closed.'));
        }
    }

    /** Stops every child at once. */
    kill(): void {
        this.closed = true;
        this.failQueued();
        for (const worker of this.workers) worker.serve.kill();
    }

    /** Ends every child's session (RayomdServe.close); calls still waiting fail. */
    async close(graceMs = 2000): Promise<void> {
        this.closed = true;
        this.failQueued();
        await Promise.all(this.workers.map(worker => worker.serve.close(graceMs)));
    }
}

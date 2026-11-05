// One rayomd command (--book, --recover-source, --version): started without a shell, its output
// collected, stopped after a timeout or when `signal` aborts.

import { spawn } from 'node:child_process';

import type { RayomdCommand } from './serve.js';

export interface RunResult {
    /** Exit code; null when the process was ended by a signal or the timeout. */
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

const MAX_OUTPUT = 1024 * 1024;

export function runRayomd(command: RayomdCommand, args: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<RunResult> {
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
    const proc = spawn(command.command, [...(command.args ?? []), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', error => {
        clearTimeout(timer);
        reject(new Error(`rayomd (${command.command}) could not be started: ${error.message}`));
    });
    proc.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, stdout, stderr, timedOut });
    });
    return promise;
}

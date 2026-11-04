// open_in_gui: starts RayoMD GUI (RAYOMD_GUI_PATH, else rayomd-gui on PATH) on a Markdown file,
// detached from the server and without a shell.

import { spawn } from 'node:child_process';
import path from 'node:path';

import { findOnPath } from './client/binary.js';

export interface GuiLaunch {
    gui: string;
    file: string;
    pid: number | undefined;
}

/** How long a GUI that fails at once (no display, bad file) is waited for. */
const EARLY_EXIT_MS = 750;

export function findGui(env: NodeJS.ProcessEnv = process.env): string {
    if (env.RAYOMD_GUI_PATH) return path.resolve(env.RAYOMD_GUI_PATH);
    const onPath = findOnPath('rayomd-gui', env);
    if (!onPath) {
        throw new Error('RayoMD GUI is not installed: put rayomd-gui on PATH or set RAYOMD_GUI_PATH ' +
            '(https://github.com/Butterski/rayomd-gui/releases/latest).');
    }
    return onPath;
}

/** Starts the GUI on `file` (a real path already checked against the roots). */
export async function openInGui(file: string, env: NodeJS.ProcessEnv = process.env): Promise<GuiLaunch> {
    const gui = findGui(env);
    if (process.platform === 'linux' && !env.WAYLAND_DISPLAY) {
        throw new Error('No Wayland display (WAYLAND_DISPLAY is not set): RayoMD GUI needs a Wayland session on Linux.');
    }
    const child = spawn(gui, [file], { detached: true, stdio: 'ignore', shell: false, windowsHide: false, env });
    const started = Promise.withResolvers<void>();
    child.once('spawn', () => started.resolve());
    child.once('error', error => started.reject(new Error(`RayoMD GUI (${gui}) could not be started: ${error.message}`)));
    await started.promise;

    // A GUI that cannot open a window exits at once; one that runs keeps going and is left alone.
    const early = Promise.withResolvers<number | null>();
    const timer = setTimeout(() => early.resolve(null), EARLY_EXIT_MS);
    child.once('exit', (code, signal) => {
        clearTimeout(timer);
        early.resolve(code ?? (signal ? -1 : 0));
    });
    const code = await early.promise;
    if (code !== null && code !== 0) throw new Error(`RayoMD GUI (${gui}) exited at once with code ${code}.`);
    child.unref();
    return { gui, file, pid: child.pid };
}

// Where the rayomd executable comes from: RAYOMD_PATH, else `rayomd` on PATH, else the release
// binary for this platform, downloaded once into a cache folder and checked against the SHA-256
// pinned in releases.ts. After the first download it works offline.

import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { extractMember } from './archive.js';
import {
    currentReleasePlatform,
    RAYOMD_VERSION,
    RELEASE_BASE_URL,
    RELEASE_SHA256,
    releaseAsset,
    type ReleasePlatform,
    type ReleaseTable,
} from './releases.js';

/** A resolved rayomd executable and where it was found. */
export interface RayomdBinary {
    path: string;
    source: 'RAYOMD_PATH' | 'PATH' | 'cache' | 'download';
}

export interface ResolveOptions {
    /** Environment to read RAYOMD_PATH and PATH from (default process.env). */
    env?: NodeJS.ProcessEnv;
    /** Release to download (default RAYOMD_VERSION). */
    version?: string;
    /** SHA-256 table (default RELEASE_SHA256). */
    releases?: ReleaseTable;
    /** Base URL of the release downloads (default the GitHub releases of Butterski/rayomd). */
    baseUrl?: string;
    /** Cache folder (default defaultCacheDir()). */
    cacheDir?: string;
    /** Platform key (default the current one). */
    platform?: ReleasePlatform;
    /** Skip RAYOMD_PATH and PATH and use only the cache or a download. */
    downloadOnly?: boolean;
    /** Only a binary already here (RAYOMD_PATH, PATH, the cache): throw instead of downloading. */
    offline?: boolean;
    /** fetch implementation (default the global one). */
    fetch?: typeof fetch;
    /** Progress messages, such as "Downloading ..." (default none). */
    log?: (message: string) => void;
}

/**
 * The cache folder of downloaded binaries: %LOCALAPPDATA%\RayoMD\cache\bin on Windows,
 * $XDG_CACHE_HOME/rayomd/bin or ~/.cache/rayomd/bin elsewhere (next to rayomd's image cache).
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
    if (process.platform === 'win32') {
        const base = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
        return path.join(base, 'RayoMD', 'cache', 'bin');
    }
    const xdg = env.XDG_CACHE_HOME;
    return path.join(xdg && path.isAbsolute(xdg) ? path.join(xdg, 'rayomd') : path.join(homedir(), '.cache', 'rayomd'), 'bin');
}

function isExecutableFile(file: string): boolean {
    try {
        if (!statSync(file).isFile()) return false;
        if (process.platform !== 'win32') accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * `name` on PATH, as the shell would find it, or undefined. On Windows only `name.exe`: a
 * .cmd or .bat would need a shell to start, and the client never uses one.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const pathValue = env.PATH ?? env.Path ?? '';
    const fileName = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
    for (const dir of pathValue.split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, fileName);
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

/** The path the release binary of `version` is kept at in `cacheDir`. */
export function cachedBinaryPath(cacheDir: string, version: string, platform: ReleasePlatform): string {
    return path.join(cacheDir, version, platform === 'win32-x64' ? 'rayomd.exe' : 'rayomd');
}

/**
 * Downloads the release archive of `version` for `platform`, checks its SHA-256 and writes the
 * binary into the cache (atomically: a partial download never becomes the cached binary).
 */
export async function downloadRelease(options: ResolveOptions = {}): Promise<string> {
    const version = options.version ?? RAYOMD_VERSION;
    const platform = options.platform ?? currentReleasePlatform();
    if (!platform) {
        throw new Error(`RayoMD publishes no binary for ${process.platform}-${process.arch}; ` +
            'build rayomd from source and put it on PATH or set RAYOMD_PATH.');
    }
    const asset = releaseAsset(version, platform, options.releases ?? RELEASE_SHA256);
    const target = cachedBinaryPath(options.cacheDir ?? defaultCacheDir(options.env), version, platform);
    const url = `${options.baseUrl ?? RELEASE_BASE_URL}/v${version}/${asset.archive}`;
    options.log?.(`Downloading ${url}`);

    const response = await (options.fetch ?? fetch)(url);
    if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== asset.sha256) {
        throw new Error(`SHA-256 mismatch for ${asset.archive}: got ${digest}, expected ${asset.sha256}; the download was not used.`);
    }
    const binary = extractMember(asset.archive, archive, asset.member);

    await mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.${process.pid}.partial`;
    try {
        await writeFile(partial, binary, { mode: 0o755 });
        await chmod(partial, 0o755);
        await rename(partial, target);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
    options.log?.(`Installed RayoMD ${version} at ${target}`);
    return target;
}

/** The rayomd executable to run: RAYOMD_PATH, else PATH, else the cache, else a download. */
export async function resolveRayomd(options: ResolveOptions = {}): Promise<RayomdBinary> {
    const env = options.env ?? process.env;
    if (!options.downloadOnly) {
        const fromEnv = env.RAYOMD_PATH;
        if (fromEnv) {
            const resolved = path.resolve(fromEnv);
            if (!isExecutableFile(resolved)) throw new Error(`RAYOMD_PATH is set to ${fromEnv}, which is not an executable file.`);
            return { path: resolved, source: 'RAYOMD_PATH' };
        }
        const onPath = findOnPath('rayomd', env);
        if (onPath) return { path: onPath, source: 'PATH' };
    }
    const version = options.version ?? RAYOMD_VERSION;
    const platform = options.platform ?? currentReleasePlatform();
    if (platform) {
        const cached = cachedBinaryPath(options.cacheDir ?? defaultCacheDir(env), version, platform);
        if (isExecutableFile(cached)) return { path: cached, source: 'cache' };
    }
    if (options.offline) throw new Error(`rayomd ${version} is not installed (RAYOMD_PATH, PATH or ${options.cacheDir ?? defaultCacheDir(env)}).`);
    return { path: await downloadRelease({ ...options, env }), source: 'download' };
}

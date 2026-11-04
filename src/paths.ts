// The folders the server reads and writes in (--root), and the checks every path from a tool call
// goes through: resolved to its real location (links, junctions and ".." followed) and refused
// unless that lies inside a root. fs/promises' realpath is the system's (uv_fs_realpath), which
// also resolves Windows junctions and the real letter case.

import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function comparable(file: string): string {
    return process.platform === 'win32' ? file.toLowerCase() : file;
}

function hasExtension(file: string, extension: string, ignoreCase: boolean): boolean {
    return ignoreCase ? file.toLowerCase().endsWith(extension) : file.endsWith(extension);
}

export class Roots {
    /** Real paths of the roots; relative paths in tool calls resolve from the first one. */
    readonly dirs: readonly string[];

    private constructor(dirs: string[]) {
        this.dirs = dirs;
    }

    /** Roots from folder paths (relative ones from the working folder); each must be a folder. */
    static async create(dirs: readonly string[]): Promise<Roots> {
        const resolved: string[] = [];
        for (const dir of dirs.length > 0 ? dirs : [process.cwd()]) {
            let real: string;
            try {
                real = await realpath(path.resolve(dir));
            } catch {
                throw new Error(`--root ${dir}: no such folder`);
            }
            if (!(await stat(real)).isDirectory()) throw new Error(`--root ${dir}: not a folder`);
            if (!resolved.some(existing => comparable(existing) === comparable(real))) resolved.push(real);
        }
        return new Roots(resolved);
    }

    /** Whether the real path `file` is a root or lies inside one. */
    contains(file: string): boolean {
        return this.dirs.some(root => {
            const relative = path.relative(comparable(root), comparable(file));
            return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
        });
    }

    private absolute(file: string, what: string): string {
        if (typeof file !== 'string' || file === '' || file.includes('\0')) throw new Error(`${what}: empty or invalid path`);
        return path.resolve(this.dirs[0]!, file);
    }

    private outside(file: string, what: string, real?: string): Error {
        const shown = real && real !== file ? `${file} (which is ${real})` : file;
        return new Error(`${what}: ${shown} is outside the folders this server may use: ${this.dirs.join(', ')}`);
    }

    /** The real path of an existing file (or, with `folder`, a file or folder) inside the roots. */
    async existing(file: string, what: string, options: { extension?: string; folder?: boolean } = {}): Promise<string> {
        const absolute = this.absolute(file, what);
        let real: string;
        try {
            real = await realpath(absolute);
        } catch {
            throw new Error(`${what}: ${file} does not exist`);
        }
        if (!this.contains(real)) throw this.outside(file, what, real);
        const info = await stat(real);
        if (!info.isFile() && !(options.folder && info.isDirectory())) {
            throw new Error(`${what}: ${file} is not a ${options.folder ? 'file or folder' : 'file'}`);
        }
        if (options.extension && info.isFile() && !hasExtension(real, options.extension, true)) {
            throw new Error(`${what}: ${file} does not end in ${options.extension}`);
        }
        return real;
    }

    /**
     * The path to write `file` at: its folder's real path inside the roots and its name, which
     * must end in `extension` (lower case) and must not be a link or a folder. With `mustNotExist`
     * an existing file is refused too.
     */
    async output(file: string, what: string, extension: string, options: { mustNotExist?: boolean } = {}): Promise<string> {
        const absolute = this.absolute(file, what);
        const name = path.basename(absolute);
        if (!name.endsWith(extension) || name === extension) throw new Error(`${what}: ${file} must end in ${extension}`);
        let folder: string;
        try {
            folder = await realpath(path.dirname(absolute));
        } catch {
            throw new Error(`${what}: the folder of ${file} does not exist`);
        }
        if (!(await stat(folder)).isDirectory()) throw new Error(`${what}: the folder of ${file} is not a folder`);
        const target = path.join(folder, name);
        if (!this.contains(target)) throw this.outside(file, what, target);
        let info;
        try {
            info = await lstat(target);
        } catch {
            return target;
        }
        if (info.isSymbolicLink()) throw new Error(`${what}: ${file} is a link; write to a plain file name`);
        if (!info.isFile()) throw new Error(`${what}: ${file} exists and is not a file`);
        // rayomd rewrites the file in place, which would change every other name of a hard link.
        if (info.nlink > 1) throw new Error(`${what}: ${file} has other hard links; write to a new file name`);
        if (options.mustNotExist) throw new Error(`${what}: ${file} already exists; choose a new file name`);
        return target;
    }
}

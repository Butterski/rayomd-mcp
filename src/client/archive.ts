// One file out of a release archive, without external tools: a .tar.gz (ustar, with pax and GNU
// long names) or a .zip (stored or deflated entries).

import { gunzipSync, inflateRawSync } from 'node:zlib';

/** The contents of `member` in `archive` (by its name ending .zip or .tar.gz), or an error. */
export function extractMember(archiveName: string, archive: Buffer, member: string): Buffer {
    if (archiveName.endsWith('.zip')) return extractZipMember(archive, member);
    if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) return extractTarMember(gunzipSync(archive), member);
    throw new Error(`Unsupported archive type: ${archiveName}`);
}

function cString(buffer: Buffer, start: number, length: number): string {
    const field = buffer.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

function octal(buffer: Buffer, start: number, length: number): number {
    const text = cString(buffer, start, length).trim();
    if (!/^[0-7]*$/.test(text)) throw new Error('Corrupt tar header');
    return text === '' ? 0 : parseInt(text, 8);
}

/** Strips a leading "./" so "./a/b" and "a/b" name the same member. */
function normalizeName(name: string): string {
    return name.replace(/^(\.\/)+/, '');
}

export function extractTarMember(tar: Buffer, member: string): Buffer {
    const wanted = normalizeName(member);
    let offset = 0;
    let longName: string | undefined;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const size = octal(header, 124, 12);
        const type = String.fromCharCode(header[156] ?? 0);
        const dataStart = offset + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        if (data.length !== size) throw new Error('Truncated tar archive');
        offset = dataStart + Math.ceil(size / 512) * 512;

        if (type === 'x') {
            // pax extended header: "LEN key=value\n" records; only path matters here.
            const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
            if (match) longName = match[1];
            continue;
        }
        if (type === 'L') {
            longName = cString(data, 0, data.length);
            continue;
        }
        if (type === 'g') continue;

        const prefix = cString(header, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
        longName = undefined;
        if ((type === '0' || type === '\0') && normalizeName(name) === wanted) return Buffer.from(data);
    }
    throw new Error(`${member} is not in the archive`);
}

export function extractZipMember(zip: Buffer, member: string): Buffer {
    const wanted = normalizeName(member);
    // End of central directory: 22 bytes plus a comment of at most 65535.
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a zip archive');
    const entries = zip.readUInt16LE(eocd + 10);
    let offset = zip.readUInt32LE(eocd + 16);
    for (let n = 0; n < entries; n++) {
        if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
        const method = zip.readUInt16LE(offset + 10);
        const compressedSize = zip.readUInt32LE(offset + 20);
        const size = zip.readUInt32LE(offset + 24);
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        const localOffset = zip.readUInt32LE(offset + 42);
        const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replace(/\\/g, '/');
        offset += 46 + nameLength + extraLength + commentLength;
        if (normalizeName(name) !== wanted) continue;

        if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt zip local header');
        const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const raw = zip.subarray(dataStart, dataStart + compressedSize);
        let data: Buffer;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = inflateRawSync(raw);
        else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
        if (data.length !== size) throw new Error(`Corrupt zip entry ${name}`);
        return data;
    }
    throw new Error(`${member} is not in the archive`);
}

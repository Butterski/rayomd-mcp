// rayomd-mcp/client: the serve client against the fake rayomd, the flag mapping, and the binary
// resolver with a local release server.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { deflateRawSync, gzipSync } from 'node:zlib';

import {
    cachedBinaryPath,
    exportArgs,
    extractMember,
    findOnPath,
    RayomdPool,
    RayomdServe,
    releaseAsset,
    resolveRayomd,
} from '../dist/client/index.js';
import { fakeCommand, removeDir, tempDir } from './helpers.mjs';

describe('RayomdServe', () => {
    let dir;
    before(() => {
        dir = tempDir();
    });
    after(() => removeDir(dir));

    test('answers requests in order from one warm child', async () => {
        const serve = new RayomdServe({ command: fakeCommand });
        try {
            const answers = await Promise.all([1, 2, 3].map(n =>
                serve.request({ markdown: `# ${n}`, source_path: path.join(dir, `${n}.md`), output: path.join(dir, `${n}.pdf`), args: ['--toc'] })));
            assert.deepEqual(answers.map(answer => answer.output), [1, 2, 3].map(n => path.join(dir, `${n}.pdf`)));
            assert.deepEqual(answers.map(answer => answer.id), [1, 2, 3]);
            assert.ok(answers.every(answer => answer.status === 'ok'));
            assert.deepEqual(serve.greeting, { rayomd: '0.0.0-fake', protocol: 1 });
            assert.match(readFileSync(path.join(dir, '2.pdf'), 'utf8'), /\["--toc"\]\n# 2/);
        } finally {
            await serve.close();
        }
    });

    test('a crashed child fails its request and the next request starts a new one', async () => {
        const serve = new RayomdServe({ command: fakeCommand });
        try {
            await assert.rejects(serve.request({ markdown: 'CRASH', output: path.join(dir, 'c.pdf') }), /exited with code 3.*crashing as asked/s);
            const answer = await serve.request({ markdown: 'fine', output: path.join(dir, 'c.pdf') });
            assert.equal(answer.status, 'ok');
        } finally {
            await serve.close();
        }
    });

    test('a request that times out stops the child; the next one works', async () => {
        const serve = new RayomdServe({ command: fakeCommand, requestTimeoutMs: 300 });
        try {
            const hanging = serve.request({ markdown: 'HANG', output: path.join(dir, 'h.pdf') });
            const queued = serve.request({ markdown: 'after', output: path.join(dir, 'h2.pdf') });
            await assert.rejects(hanging, /did not answer the request within 0.3 s/);
            assert.equal((await queued).status, 'ok');
        } finally {
            await serve.close();
        }
    });

    test('a non-JSON answer fails the request and restarts the child', async () => {
        const serve = new RayomdServe({ command: fakeCommand });
        try {
            await assert.rejects(serve.request({ markdown: 'GARBAGE', output: path.join(dir, 'g.pdf') }), /not JSON/);
            assert.equal((await serve.request({ markdown: 'ok', output: path.join(dir, 'g.pdf') })).status, 'ok');
        } finally {
            await serve.close();
        }
    });

    test('a rayomd without --serve --json is reported', async () => {
        const serve = new RayomdServe({
            command: {
                command: process.execPath,
                args: ['-e', "process.env.FAKE_RAYOMD_OLD = '1'; import(require('node:url').pathToFileURL(process.argv[1]).href);", fakeCommand.args[0]],
            },
            startTimeoutMs: 300,
        });
        try {
            await assert.rejects(serve.request({ markdown: 'x', output: path.join(dir, 'o.pdf') }), /may be a RayoMD without --serve --json/);
        } finally {
            await serve.close();
        }
    });

    test('a program that cannot be started is reported', async () => {
        const serve = new RayomdServe({ command: { command: path.join(dir, 'no-such-rayomd') } });
        await assert.rejects(serve.request({ markdown: 'x', output: path.join(dir, 'o.pdf') }), /could not be started/);
        await serve.close();
    });

    test('a request over 32 MiB is refused before it is sent', async () => {
        const serve = new RayomdServe({ command: fakeCommand });
        await assert.rejects(serve.request({ markdown: 'x'.repeat(32 * 1024 * 1024), output: path.join(dir, 'big.pdf') }), /larger than/);
        await serve.close();
    });
});

describe('RayomdPool', () => {
    let dir;
    before(() => {
        dir = tempDir();
    });
    after(() => removeDir(dir));

    const slow = (pool, name) => pool.request({ markdown: `SLOW ${name}`, output: path.join(dir, `${name}.pdf`) });

    test('overlapping requests run on several children, one child for one caller', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 4 });
        try {
            assert.equal((await slow(pool, 'warm')).status, 'ok');
            const first = pool.pid;
            // Four conversions of 200 ms each at once: about 200 ms on four children, 800 on one.
            const start = Date.now();
            const answers = await Promise.all(['a', 'b', 'c', 'd'].map(name => slow(pool, name)));
            assert.ok(answers.every(answer => answer.status === 'ok'));
            assert.ok(Date.now() - start < 700, `took ${Date.now() - start} ms`);
            assert.equal(pool.pid, first);
        } finally {
            await pool.close();
        }
        await assert.rejects(slow(pool, 'closed'), /closed/);
    });

    test('requests for one output path run one after the other, in their order', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 4 });
        try {
            const output = path.join(dir, 'same.pdf');
            const finished = [];
            await Promise.all([
                pool.request({ markdown: 'SLOW first', output }).then(() => finished.push('first')),
                pool.request({ markdown: 'second', output }).then(() => finished.push('second')),
            ]);
            assert.deepEqual(finished, ['first', 'second']);
            assert.match(readFileSync(output, 'utf8'), /second$/);
        } finally {
            await pool.close();
        }
    });

    test('maxChildren 1 keeps every request on one child', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 1 });
        try {
            const start = Date.now();
            await Promise.all(['e', 'f', 'g'].map(name => slow(pool, name)));
            assert.ok(Date.now() - start >= 590, `took ${Date.now() - start} ms`);
        } finally {
            await pool.close();
        }
    });

    test('warm starts the first child before the first request, which then uses it', async () => {
        const pool = new RayomdPool({ command: fakeCommand });
        try {
            pool.warm();
            for (let waited = 0; pool.greeting === undefined && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
            const pid = pool.pid;
            assert.ok(pid !== undefined);
            assert.equal((await pool.request({ markdown: 'x', output: path.join(dir, 'w.pdf') })).status, 'ok');
            assert.equal(pool.pid, pid);
        } finally {
            await pool.close();
        }
    });

    const waitFor = async (condition, ms = 5000) => {
        for (let waited = 0; !condition() && waited < ms; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    };

    test('a burst of small calls is cleared by the warm child without new ones', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 4 });
        try {
            await pool.request({ markdown: 'warm', output: path.join(dir, 'burst-warm.pdf') });
            await Promise.all(Array.from({ length: 6 }, (_, n) => pool.request({ markdown: `${n}`, output: path.join(dir, `burst${n}.pdf`) })));
            assert.equal(pool.children, 1);
        } finally {
            await pool.close();
        }
    });

    test('calls go to the child free first, not to one still starting', async () => {
        process.env.FAKE_RAYOMD_START_MS = '600';
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 4 });
        try {
            pool.warm();
            await waitFor(() => pool.greeting !== undefined);
            // The warm child is busy 200 ms; a second child starts and greets after 600 ms. The
            // calls waiting meanwhile go to the warm child once it is free.
            const start = Date.now();
            const busy = slow(pool, 'busy-warm');
            await Promise.all(Array.from({ length: 3 }, (_, n) => pool.request({ markdown: `${n}`, output: path.join(dir, `free${n}.pdf`) })));
            assert.ok(Date.now() - start < 500, `took ${Date.now() - start} ms`);
            await busy;
            assert.equal(pool.children, 2);
        } finally {
            delete process.env.FAKE_RAYOMD_START_MS;
            await pool.close();
        }
    });

    test('a call does not wait behind a slow build while another child is free', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 2 });
        try {
            await Promise.all([slow(pool, 'two1'), slow(pool, 'two2')]);
            assert.equal(pool.children, 2);
            const big = slow(pool, 'big');
            const start = Date.now();
            await Promise.all(Array.from({ length: 5 }, (_, n) => pool.request({ markdown: `${n}`, output: path.join(dir, `quick${n}.pdf`) })));
            assert.ok(Date.now() - start < 150, `took ${Date.now() - start} ms`);
            await big;
        } finally {
            await pool.close();
        }
    });

    test('a waiting call is cancelled by its signal and never reaches rayomd', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 1 });
        try {
            const busy = slow(pool, 'busy');
            const controller = new AbortController();
            const output = path.join(dir, 'cancelled.pdf');
            const waiting = pool.request({ markdown: 'x', output }, { signal: controller.signal });
            controller.abort();
            await assert.rejects(waiting, /cancelled/);
            await busy;
            assert.equal(existsSync(output), false);
            await assert.rejects(pool.request({ markdown: 'x', output }, { signal: controller.signal }), /cancelled/);
        } finally {
            await pool.close();
        }
    });

    test('one-shot runs share the slots: at most maxChildren rayomd processes work', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 1 });
        try {
            await pool.request({ markdown: 'warm', output: path.join(dir, 'slot-warm.pdf') });
            const order = [];
            const run = pool.run(() => new Promise(resolve => setTimeout(() => {
                order.push('run');
                resolve();
            }, 200)));
            await pool.request({ markdown: 'after', output: path.join(dir, 'slot.pdf') }).then(() => order.push('request'));
            await run;
            assert.deepEqual(order, ['run', 'request']);
            // A running one-shot command gets the call's signal.
            const controller = new AbortController();
            const stopped = pool.run(signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
                { signal: controller.signal });
            controller.abort();
            await assert.rejects(stopped, /stopped/);
        } finally {
            await pool.close();
        }
    });

    test('children beyond the first end when idle', async () => {
        const pool = new RayomdPool({ command: fakeCommand, maxChildren: 3, idleMs: 150 });
        try {
            await Promise.all(['i1', 'i2', 'i3'].map(name => slow(pool, name)));
            assert.equal(pool.children, 3);
            await waitFor(() => pool.children === 1, 2000);
            assert.equal(pool.children, 1);
            assert.equal((await slow(pool, 'i4')).status, 'ok');
        } finally {
            await pool.close();
        }
    });

    test('a rayomd that cannot start fails the waiting calls instead of leaving them', async () => {
        const pool = new RayomdPool({ command: { command: path.join(dir, 'no-such-rayomd') } });
        await assert.rejects(pool.request({ markdown: 'x', output: path.join(dir, 'n1.pdf') }), /could not be started/);
        await assert.rejects(pool.request({ markdown: 'x', output: path.join(dir, 'n2.pdf') }), /could not be started/);
        await pool.close();
    });
});

test('exportArgs maps every option to its rayomd flag', () => {
    assert.deepEqual(exportArgs({}), []);
    assert.deepEqual(exportArgs({
        style: 'tech', margin: 'margin=0.75in', page_size: 'a5-landscape', toc: true, toc_depth: 2, number_headings: 3,
        page_numbers: true, footnotes: 'page', dialect: 'obsidian', pdfa: true, pdfua: true, black_text: true,
        highlight_code: false, diagrams: false, page_break_before: 'h1', allow_url_images: true,
        allow_unsafe_local_images: true, embed_source: true, theme: '/t/theme.txt',
    }), [
        'tech', 'margin=0.75in', '--page-size=a5-landscape', '--toc', '--toc-depth=2', '--number-headings=3', '--page-numbers',
        '--footnotes=page', '--dialect=obsidian', '--pdfa', '--pdfua', '--black-text', '--no-highlight', '--no-diagrams',
        '--page-break-before=h1', '--allow-url-images', '--allow-unsafe-local-images', '--embed-source', '--theme=/t/theme.txt',
    ]);
    assert.deepEqual(exportArgs({ toc: false, highlight_code: true, diagrams: true, pdfa: false }), []);
    assert.throws(() => exportArgs({ toc_depth: 7 }), /1 to 6/);
});

// A tar member: a ustar header and the data padded to 512 bytes.
function tarEntry(name, data) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\u000000', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

// A zip of deflated entries.
function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, data] of entries) {
        const compressed = deflateRawSync(data);
        const nameBytes = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, compressed);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + compressed.length;
    }
    const centralDir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralDir, end]);
}

test('extractMember reads a .tar.gz and a .zip member', () => {
    const binary = Buffer.from('#!/bin/sh\necho rayomd\n');
    const tarGz = gzipSync(Buffer.concat([tarEntry('pkg/README.md', Buffer.from('readme')), tarEntry('pkg/rayomd', binary), Buffer.alloc(1024)]));
    assert.deepEqual(extractMember('x.tar.gz', tarGz, 'pkg/rayomd'), binary);
    const archive = zip([['pkg/LICENSE', Buffer.from('license')], ['pkg/rayomd.exe', binary]]);
    assert.deepEqual(extractMember('x.zip', archive, 'pkg/rayomd.exe'), binary);
    assert.throws(() => extractMember('x.zip', archive, 'pkg/other'), /not in the archive/);
});

test('releaseAsset names the release workflow assets and needs a pinned hash', () => {
    assert.deepEqual(releaseAsset('5.2.5', 'linux-x64'), {
        archive: 'rayomd-5.2.5-linux-x64-static.tar.gz',
        member: 'rayomd-5.2.5-linux-x64-static/rayomd',
        sha256: '254ae746f656ee576ba85fc33a11643b61449d53d59ed85f20fc014418361d1d',
    });
    assert.equal(releaseAsset('5.2.5', 'win32-x64').archive, 'rayomd-5.2.5-windows-x64.zip');
    assert.throws(() => releaseAsset('0.0.1', 'linux-x64'), /No pinned SHA-256/);
});

describe('resolveRayomd', () => {
    let dir;
    let server;
    let baseUrl;
    let requests = 0;
    const binary = Buffer.from('fake rayomd binary\n');
    const archives = {};

    before(async () => {
        dir = tempDir();
        archives['/v9.9.9/rayomd-9.9.9-linux-x64-static.tar.gz'] =
            gzipSync(Buffer.concat([tarEntry('rayomd-9.9.9-linux-x64-static/rayomd', binary), Buffer.alloc(1024)]));
        archives['/v9.9.9/rayomd-9.9.9-windows-x64.zip'] = zip([['rayomd-9.9.9-windows-x64/rayomd.exe', binary]]);
        server = createServer((request, response) => {
            requests++;
            const body = archives[request.url];
            response.writeHead(body ? 200 : 404);
            response.end(body);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => {
        server.close();
        removeDir(dir);
    });

    const sha = buffer => createHash('sha256').update(buffer).digest('hex');
    const empty = { PATH: '' };

    for (const platform of ['linux-x64', 'win32-x64']) {
        test(`downloads, checks and caches the ${platform} binary, then works offline`, async () => {
            const archive = archives[platform === 'linux-x64' ? '/v9.9.9/rayomd-9.9.9-linux-x64-static.tar.gz' : '/v9.9.9/rayomd-9.9.9-windows-x64.zip'];
            const cacheDir = path.join(dir, `cache-${platform}`);
            const options = { env: empty, version: '9.9.9', releases: { '9.9.9': { [platform]: sha(archive) } }, baseUrl, cacheDir, platform };
            const first = await resolveRayomd(options);
            assert.equal(first.source, 'download');
            assert.equal(first.path, cachedBinaryPath(cacheDir, '9.9.9', platform));
            assert.deepEqual(readFileSync(first.path), binary);
            const before = requests;
            const second = await resolveRayomd({ ...options, baseUrl: 'http://127.0.0.1:9' });
            assert.deepEqual(second, { path: first.path, source: 'cache' });
            assert.equal(requests, before);
        });

        test(`offline finds the cached ${platform} binary and downloads nothing without it`, async () => {
            const cacheDir = path.join(dir, `cache-${platform}`);
            const before = requests;
            const options = { env: empty, version: '9.9.9', baseUrl, platform, offline: true };
            assert.equal((await resolveRayomd({ ...options, cacheDir })).source, 'cache');
            await assert.rejects(resolveRayomd({ ...options, cacheDir: path.join(dir, 'cache-none') }), /is not installed/);
            assert.equal(requests, before);
        });
    }

    test('refuses a download whose SHA-256 does not match', async () => {
        const cacheDir = path.join(dir, 'cache-bad');
        await assert.rejects(resolveRayomd({
            env: empty, version: '9.9.9', releases: { '9.9.9': { 'linux-x64': '0'.repeat(64) } }, baseUrl, cacheDir, platform: 'linux-x64',
        }), /SHA-256 mismatch/);
        assert.equal(existsSync(cachedBinaryPath(cacheDir, '9.9.9', 'linux-x64')), false);
    });

    test('RAYOMD_PATH comes first, then PATH', async () => {
        const program = path.join(dir, process.platform === 'win32' ? 'rayomd.exe' : 'rayomd');
        writeFileSync(program, 'x');
        chmodSync(program, 0o755);
        assert.deepEqual(await resolveRayomd({ env: { RAYOMD_PATH: program, PATH: '' } }), { path: program, source: 'RAYOMD_PATH' });
        assert.deepEqual(await resolveRayomd({ env: { PATH: dir } }), { path: program, source: 'PATH' });
        assert.equal(findOnPath('rayomd', { PATH: dir }), program);
        await assert.rejects(resolveRayomd({ env: { RAYOMD_PATH: path.join(dir, 'missing') } }), /not an executable file/);
    });
});

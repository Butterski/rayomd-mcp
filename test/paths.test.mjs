// Roots: every path is checked on its real location.

import assert from 'node:assert/strict';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { Roots } from '../dist/index.js';
import { removeDir, tempDir } from './helpers.mjs';

/** Makes a symbolic link (a junction for folders on Windows); false when the system refuses. */
function trySymlink(target, link, folder = false) {
    try {
        symlinkSync(target, link, folder && process.platform === 'win32' ? 'junction' : undefined);
        return true;
    } catch {
        return false;
    }
}

describe('Roots', () => {
    let base;
    let root;
    let other;
    let roots;
    before(async () => {
        base = tempDir();
        root = path.join(base, 'root');
        other = path.join(base, 'other');
        mkdirSync(path.join(root, 'sub'), { recursive: true });
        mkdirSync(other);
        writeFileSync(path.join(root, 'a.md'), '# a');
        writeFileSync(path.join(root, 'sub', 'b.md'), '# b');
        writeFileSync(path.join(other, 'secret.md'), '# secret');
        roots = await Roots.create([root]);
    });
    after(() => removeDir(base));

    test('relative paths resolve from the first root', async () => {
        assert.equal(await roots.existing('a.md', 'path'), path.join(root, 'a.md'));
        assert.equal(await roots.existing('sub/../a.md', 'path'), path.join(root, 'a.md'));
        assert.equal(await roots.output('sub/out.pdf', 'output', '.pdf'), path.join(root, 'sub', 'out.pdf'));
    });

    test('.. out of the root is refused', async () => {
        await assert.rejects(roots.existing('../other/secret.md', 'path'), /outside the folders/);
        await assert.rejects(roots.output('../other/x.pdf', 'output', '.pdf'), /outside the folders/);
        await assert.rejects(roots.output('..', 'output', '.pdf'), /must end in .pdf/);
    });

    test('absolute paths elsewhere are refused, inside accepted', async () => {
        await assert.rejects(roots.existing(path.join(other, 'secret.md'), 'path'), /outside the folders/);
        await assert.rejects(roots.output(path.join(other, 'x.pdf'), 'output', '.pdf'), /outside the folders/);
        assert.equal(await roots.existing(path.join(root, 'a.md'), 'path'), path.join(root, 'a.md'));
    });

    test('outputs must end in .pdf and their folder must exist', async () => {
        await assert.rejects(roots.output('out.md', 'output', '.pdf'), /must end in .pdf/);
        await assert.rejects(roots.output('out.PDF', 'output', '.pdf'), /must end in .pdf/);
        await assert.rejects(roots.output('.pdf', 'output', '.pdf'), /must end in .pdf/);
        await assert.rejects(roots.output('missing/out.pdf', 'output', '.pdf'), /folder of missing\/out.pdf does not exist/);
        await assert.rejects(roots.output('sub', 'output', '.pdf'), /must end in .pdf/);
        await assert.rejects(roots.output('a.md', 'output', '.md', { mustNotExist: true }), /already exists/);
    });

    test('links out of the root are refused', async t => {
        if (!trySymlink(path.join(other, 'secret.md'), path.join(root, 'link.md')) ||
            !trySymlink(other, path.join(root, 'linkdir'), true) ||
            !trySymlink(path.join(other, 'target.pdf'), path.join(root, 'link.pdf'))) {
            t.skip('symbolic links are not permitted here');
            return;
        }
        await assert.rejects(roots.existing('link.md', 'path'), /outside the folders/);
        await assert.rejects(roots.existing('linkdir/secret.md', 'path'), /outside the folders/);
        await assert.rejects(roots.output('linkdir/x.pdf', 'output', '.pdf'), /outside the folders/);
        await assert.rejects(roots.output('link.pdf', 'output', '.pdf'), /is a link/);
    });

    test('an output with other hard links is refused', async () => {
        writeFileSync(path.join(other, 'keep.pdf'), 'x');
        linkSync(path.join(other, 'keep.pdf'), path.join(root, 'hard.pdf'));
        await assert.rejects(roots.output('hard.pdf', 'output', '.pdf'), /hard links/);
    });

    test('several roots; a missing root is an error', async () => {
        const two = await Roots.create([root, other]);
        assert.equal(await two.existing(path.join(other, 'secret.md'), 'path'), path.join(other, 'secret.md'));
        await assert.rejects(Roots.create([path.join(base, 'nope')]), /no such folder/);
    });
});

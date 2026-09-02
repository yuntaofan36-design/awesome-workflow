import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPackableEntry,
  assertSafeArchivePath,
  buildDeterministicZip,
  collectArchiveEntries,
} from './archive.js';

test('deterministic ZIP is byte-for-byte stable regardless of input order', () => {
  const first = buildDeterministicZip([
    { name: 'z.txt', bytes: Buffer.from('z') },
    { name: 'assets/a.txt', bytes: Buffer.from('a') },
  ]);
  const second = buildDeterministicZip([
    { name: 'assets/a.txt', bytes: Buffer.from('a') },
    { name: 'z.txt', bytes: Buffer.from('z') },
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(0), 0x04034b50);
});

test('archive paths reject traversal, Windows hazards, and symlinks', () => {
  for (const unsafe of [
    '../escape.txt',
    '/absolute.txt',
    'C:/drive.txt',
    'safe/../escape',
    'safe\\escape.txt',
    'safe/file:stream',
    'CON',
    'folder/NUL.txt',
    'tail.',
  ]) {
    assert.throws(() => assertSafeArchivePath(unsafe));
  }
  assert.throws(() => assertPackableEntry('payload/link', 'symbolic-link'), /symbolic link/);
  assert.doesNotThrow(() => assertPackableEntry('payload/bin/tool.exe', 'file'));
});

test('filesystem collection refuses symbolic links before reading their target', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-archive-'));
  const root = join(directory, 'root');
  const outside = join(directory, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    try {
      await symlink(outside, join(root, 'link'), 'junction');
    } catch (error) {
      if (isNodeError(error) && ['EPERM', 'EACCES'].includes(error.code ?? '')) {
        context.skip('Creating symlinks is not permitted on this Windows host.');
        return;
      }
      throw error;
    }
    await assert.rejects(collectArchiveEntries(root), /symbolic link/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

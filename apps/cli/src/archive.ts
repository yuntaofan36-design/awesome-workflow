import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { cliText } from './i18n.js';
import { CliError } from './safety.js';

export type ArchiveEntry = {
  name: string;
  bytes: Uint8Array;
};

export async function collectArchiveEntries(root: string): Promise<ArchiveEntry[]> {
  const absoluteRoot = await realpath(resolve(root));
  const entries: ArchiveEntry[] = [];
  await walk(absoluteRoot, absoluteRoot, entries);
  if (!entries.length) throw new CliError(cliText('archive.empty'));
  return entries;
}

export function buildDeterministicZip(input: readonly ArchiveEntry[]): Buffer {
  const entries = [...input]
    .map((entry) => {
      assertPackableEntry(entry.name, 'file');
      return {
        name: entry.name,
        nameBytes: Buffer.from(entry.name, 'utf8'),
        bytes: Buffer.from(entry.bytes),
      };
    })
    .sort((left, right) => compareNames(left.name, right.name));

  if (entries.length > 0xffff) throw new CliError(cliText('archive.tooManyFiles'));
  const foldedNames = new Set<string>();
  for (const entry of entries) {
    const folded = entry.name.toLocaleLowerCase('en-US');
    if (foldedNames.has(folded)) throw new CliError(cliText('archive.duplicatePath'));
    foldedNames.add(folded);
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(entry.nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, entry.nameBytes, entry.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, entry.nameBytes);
    offset += local.length + entry.nameBytes.length + entry.bytes.length;
    if (offset > 0xffffffff) throw new CliError(cliText('archive.tooLarge'));
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function assertPackableEntry(name: string, kind: 'file' | 'symbolic-link' | 'other'): void {
  assertSafeArchivePath(name);
  if (kind === 'symbolic-link') throw new CliError(cliText('archive.symbolicLink', { name }));
  if (kind !== 'file') throw new CliError(cliText('archive.nonRegular', { name }));
}

export function assertSafeArchivePath(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new CliError(cliText('archive.invalidPath'));
  }
  const components = name.split('/').filter(Boolean);
  if (!components.length || components.some((component) => component === '.' || component === '..')) {
    throw new CliError(cliText('archive.pathEscape'));
  }
  for (const component of components) {
    if (component.includes(':') || /[. ]$/.test(component)) {
      throw new CliError(cliText('archive.windowsUnsafe'));
    }
    const stem = component.split('.')[0]!.toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new CliError(cliText('archive.windowsReserved'));
    }
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function walk(root: string, directory: string, output: ArchiveEntry[]): Promise<void> {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => compareNames(left.name, right.name));
  for (const child of children) {
    const absolute = join(directory, child.name);
    const archiveName = relative(root, absolute).replaceAll('\\', '/');
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      assertPackableEntry(archiveName, 'symbolic-link');
    } else if (metadata.isDirectory()) {
      await walk(root, absolute, output);
    } else if (metadata.isFile()) {
      assertPackableEntry(archiveName, 'file');
      output.push({ name: archiveName, bytes: await readFile(absolute) });
    } else {
      assertPackableEntry(archiveName, 'other');
    }
  }
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

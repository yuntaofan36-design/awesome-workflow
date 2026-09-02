import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../../..');
const profile = process.argv[2] === 'debug' ? 'debug' : 'release';
const target = process.argv[3];
const extension = (target?.includes('windows') ?? process.platform === 'win32') ? '.exe' : '';
const destinationDirectory = resolve(scriptDirectory, '../src-tauri/sidecars');
const sourceDirectory = target
  ? resolve(repositoryRoot, 'target', target, profile)
  : resolve(repositoryRoot, 'target', profile);
const binaries = ['awesome-workflow-agent', 'awesome-workflow-runner', 'awesome-workflow-elevated-helper'];

mkdirSync(destinationDirectory, { recursive: true });
for (const binary of binaries) {
  const fileName = `${binary}${extension}`;
  copyFileSync(resolve(sourceDirectory, fileName), resolve(destinationDirectory, fileName));
}

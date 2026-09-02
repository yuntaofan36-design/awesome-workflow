import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DesktopReleaseManifestSchema } from '../packages/manifest-schema/src/index.js';

const examplesDirectory = dirname(fileURLToPath(import.meta.url));
const manifests = [
  'desktop-applet/applet.json',
  'desktop-native-applet/applet.json',
  'desktop-web-ui-applet/applet.json',
] as const;
const placeholderDigest = '0'.repeat(64);
const unsignedTemplateSignature = 'UNSIGNED_TEMPLATE_REPLACED_BY_AW_PACKAGE_000000000000000000000000';

async function main(): Promise<void> {
  for (const manifestPath of manifests) {
    const absolutePath = join(examplesDirectory, manifestPath);
    const raw = JSON.parse(await readFile(absolutePath, 'utf8')) as unknown;
    const manifest = DesktopReleaseManifestSchema.parse(raw);
    const packageMap = JSON.parse(await readFile(join(dirname(absolutePath), 'aw.package.json'), 'utf8')) as {
      schemaVersion?: unknown;
      artifacts?: Array<{ name?: unknown }>;
    };

    if (
      manifest.integrity.digest !== placeholderDigest ||
      manifest.artifacts.some((artifact) => artifact.sha256 !== placeholderDigest || artifact.size !== 1) ||
      manifest.signature.keyId !== 'unconfigured-publisher-key' ||
      manifest.signature.value !== unsignedTemplateSignature
    ) {
      throw new Error(`${manifestPath} must remain an explicitly unsigned packaging template`);
    }
    const mappedNames = new Set(packageMap.artifacts?.map((artifact) => artifact.name));
    if (
      packageMap.schemaVersion !== 1 ||
      mappedNames.size !== manifest.artifacts.length ||
      manifest.artifacts.some((artifact) => !mappedNames.has(artifact.name))
    ) {
      throw new Error(`${manifestPath} package map must cover every declared artifact exactly once`);
    }

    const targets = manifest.runtimes
      .map((runtime) => `${runtime.kind}:${runtime.platform.os}/${runtime.platform.arch}`)
      .join(', ');
    console.log(`[valid] ${relative(examplesDirectory, absolutePath)} (${targets})`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

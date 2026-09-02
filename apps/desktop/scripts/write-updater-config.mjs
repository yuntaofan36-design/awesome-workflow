import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const bundleConfigPath = resolve(desktopDirectory, 'src-tauri/tauri.bundle.conf.json');
const outputPath = resolve(desktopDirectory, process.argv[2] ?? 'src-tauri/tauri.release.conf.json');

const endpoint = requireHttpsEndpoint(process.env.AW_DESKTOP_UPDATER_ENDPOINT);
const publicKey = requirePublicKey(process.env.AW_DESKTOP_UPDATER_PUBLIC_KEY);
const bundleConfig = JSON.parse(await readFile(bundleConfigPath, 'utf8'));
const releaseConfig = {
  ...bundleConfig,
  plugins: {
    updater: {
      endpoints: [endpoint],
      pubkey: publicKey,
    },
  },
};

await writeFile(outputPath, `${JSON.stringify(releaseConfig, null, 2)}\n`, {
  encoding: 'utf8',
  flag: 'w',
  mode: 0o600,
});
console.log(`Wrote updater release configuration to ${outputPath}`);

function requireHttpsEndpoint(value) {
  const endpointValue = requireBuildValue(value, 'AW_DESKTOP_UPDATER_ENDPOINT', 2_048);
  let parsed;
  try {
    parsed = new URL(endpointValue);
  } catch {
    throw new Error('AW_DESKTOP_UPDATER_ENDPOINT must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('AW_DESKTOP_UPDATER_ENDPOINT must use HTTPS');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('AW_DESKTOP_UPDATER_ENDPOINT cannot contain credentials or a fragment');
  }
  return endpointValue;
}

function requirePublicKey(value) {
  const publicKey = requireBuildValue(value, 'AW_DESKTOP_UPDATER_PUBLIC_KEY', 4_096);
  if (/PRIVATE KEY/i.test(publicKey)) {
    throw new Error('AW_DESKTOP_UPDATER_PUBLIC_KEY must not contain private key material');
  }
  if (publicKey.length < 40) {
    throw new Error('AW_DESKTOP_UPDATER_PUBLIC_KEY is too short');
  }
  return publicKey;
}

function requireBuildValue(value, name, maximumLength) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for a release build`);
  if (normalized.length > maximumLength || /[\0\r]/.test(normalized)) {
    throw new Error(`${name} is malformed`);
  }
  return normalized;
}

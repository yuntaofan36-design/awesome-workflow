import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportOnly = process.argv.includes('--report-only');

const applications = [
  {
    name: 'web-shell',
    dist: 'apps/web-shell/dist',
    entries: [
      {
        name: 'session-probe',
        key: 'index.html',
        html: 'index.html',
        budgets: { cssGzip: 18_000, cssRaw: 100_000, jsGzip: 145_000, jsRaw: 460_000 },
        mustStayDynamic: [
          'src/components/LoginScreen.tsx',
          { key: 'ShellLayout', source: 'src/components/ShellLayout.tsx' },
          'src/runtime/FederationRuntime.tsx',
          'src/runtime/IframeRuntime.tsx',
          'src/runtime/LinkRuntime.tsx',
        ],
      },
    ],
    maxAssetBudgets: { cssGzip: 20_000, cssRaw: 180_000, jsGzip: 80_000, jsRaw: 250_000 },
  },
  {
    name: 'desktop',
    dist: 'apps/desktop/dist',
    entries: [
      {
        name: 'anonymous',
        key: 'index.html',
        html: 'index.html',
        budgets: { cssGzip: 25_000, cssRaw: 150_000, jsGzip: 190_000, jsRaw: 600_000 },
        mustStayDynamic: [
          'src/components/AppShell.tsx',
          'src/pages/DashboardPage.tsx',
          'src/pages/DeveloperPage.tsx',
          'src/pages/InstalledPage.tsx',
          'src/pages/SchedulesPage.tsx',
          'src/pages/SecurityPage.tsx',
          'src/pages/TasksPage.tsx',
          'src/pages/UpdatePage.tsx',
          'capability-dialog',
          'capability-updater',
        ],
      },
    ],
    maxAssetBudgets: { cssGzip: 30_000, cssRaw: 160_000, jsGzip: 110_000, jsRaw: 350_000 },
  },
  {
    name: 'control-plane',
    dist: 'apps/control-plane/dist',
    entries: [
      {
        name: 'standalone',
        key: 'index.html',
        html: 'index.html',
        budgets: { cssGzip: 20_000, cssRaw: 110_000, jsGzip: 285_000, jsRaw: 920_000 },
        mustStayDynamic: [
          { key: 'ApplicationsPage', source: 'src/pages/ApplicationsPage.tsx' },
          'src/pages/ReleasesPage.tsx',
          'src/pages/ChannelsPage.tsx',
          'src/pages/ApprovalsPage.tsx',
          'src/components/RegisterApplicationModal.tsx',
        ],
      },
      {
        name: 'federation-remote',
        key: 'remoteEntry',
        federation: { expose: 'app', manifest: 'mf-manifest.json' },
        budgets: { cssGzip: 5_000, cssRaw: 10_000, jsGzip: 35_000, jsRaw: 100_000 },
        mustStayDynamic: [
          { key: 'ApplicationsPage', source: 'src/pages/ApplicationsPage.tsx' },
          'src/pages/ReleasesPage.tsx',
          'src/pages/ChannelsPage.tsx',
          'src/pages/ApprovalsPage.tsx',
          'src/components/RegisterApplicationModal.tsx',
        ],
      },
    ],
    maxAssetBudgets: { cssGzip: 20_000, cssRaw: 130_000, jsGzip: 100_000, jsRaw: 320_000 },
  },
];

const failures = [];

for (const application of applications) {
  const distDirectory = resolve(workspaceRoot, application.dist);
  const manifestPath = join(distDirectory, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) {
    failures.push(
      `${application.name}: missing ${relative(workspaceRoot, manifestPath)}; run pnpm build first`,
    );
    continue;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const entry of application.entries) {
    const closure = entry.html
      ? collectHtmlClosure(manifest, distDirectory, entry.html, failures, application.name)
      : entry.federation
        ? collectFederationClosure(
            manifest,
            distDirectory,
            entry.key,
            entry.federation,
            failures,
            application.name,
          )
        : collectSynchronousClosure(manifest, entry.key, failures, application.name);
    if (!closure) continue;

    const javascript = measureAssets(distDirectory, closure.assets, '.js');
    const css = measureAssets(distDirectory, closure.assets, '.css');
    console.log(
      `${application.name}:${entry.name} initial JS ${formatSize(javascript.raw)} raw / ${formatSize(javascript.gzip)} gzip; ` +
        `CSS ${formatSize(css.raw)} raw / ${formatSize(css.gzip)} gzip`,
    );

    checkBudget(`${application.name}:${entry.name} initial JS raw`, javascript.raw, entry.budgets.jsRaw);
    checkBudget(`${application.name}:${entry.name} initial JS gzip`, javascript.gzip, entry.budgets.jsGzip);
    checkBudget(`${application.name}:${entry.name} initial CSS raw`, css.raw, entry.budgets.cssRaw);
    checkBudget(`${application.name}:${entry.name} initial CSS gzip`, css.gzip, entry.budgets.cssGzip);

    for (const configuredBoundary of entry.mustStayDynamic) {
      const boundary =
        typeof configuredBoundary === 'string'
          ? {
              key: configuredBoundary,
              source: configuredBoundary.includes('/') ? configuredBoundary : undefined,
            }
          : configuredBoundary;
      if (boundary.source && !existsSync(resolve(distDirectory, '..', boundary.source))) {
        failures.push(
          `${application.name}:${entry.name} dynamic boundary source ${boundary.source} does not exist`,
        );
        continue;
      }
      const boundaryKey = findManifestKey(
        manifest,
        boundary.key,
        failures,
        `${application.name}:${entry.name} dynamic boundary`,
      );
      const record = boundaryKey ? manifest[boundaryKey] : undefined;
      if (!record) {
        failures.push(`${application.name}:${entry.name} missing dynamic boundary ${boundary.key}`);
      } else if (closure.keys.has(boundaryKey)) {
        failures.push(`${application.name}:${entry.name} synchronously includes ${boundary.key}`);
      } else if (boundary.source && !record.isDynamicEntry) {
        failures.push(`${application.name}:${entry.name} boundary ${boundary.key} is not a dynamic entry`);
      }
    }
  }

  const allAssets = walkAssets(distDirectory);
  const largestJavaScript = largestAsset(distDirectory, allAssets, '.js');
  const largestCss = largestAsset(distDirectory, allAssets, '.css');
  console.log(
    `${application.name} largest JS ${formatSize(largestJavaScript.raw)} raw / ${formatSize(largestJavaScript.gzip)} gzip ` +
      `(${largestJavaScript.file}); CSS ${formatSize(largestCss.raw)} raw / ${formatSize(largestCss.gzip)} gzip ` +
      `(${largestCss.file})`,
  );
  checkBudget(`${application.name} max JS raw`, largestJavaScript.raw, application.maxAssetBudgets.jsRaw);
  checkBudget(`${application.name} max JS gzip`, largestJavaScript.gzip, application.maxAssetBudgets.jsGzip);
  checkBudget(`${application.name} max CSS raw`, largestCss.raw, application.maxAssetBudgets.cssRaw);
  checkBudget(`${application.name} max CSS gzip`, largestCss.gzip, application.maxAssetBudgets.cssGzip);
}

if (failures.length > 0) {
  const label = reportOnly ? 'Bundle report warnings' : 'Bundle budget failures';
  console.error(`\n${label}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  if (!reportOnly) process.exitCode = 1;
}

function collectSynchronousClosure(manifest, entryKey, errors, applicationName) {
  const resolvedEntryKey = findManifestKey(manifest, entryKey, errors, `${applicationName} entry`);
  if (!resolvedEntryKey) {
    errors.push(`${applicationName}: manifest entry ${entryKey} is missing`);
    return null;
  }

  const keys = new Set();
  const assets = new Set();
  const visit = (key) => {
    if (keys.has(key)) return;
    const record = manifest[key];
    if (!record) {
      errors.push(`${applicationName}: manifest import ${key} is missing`);
      return;
    }
    keys.add(key);
    if (record.file) assets.add(record.file);
    for (const cssFile of record.css ?? []) assets.add(cssFile);
    for (const dependency of record.imports ?? []) visit(dependency);
  };
  visit(resolvedEntryKey);
  return { assets, keys };
}

function collectFederationClosure(manifest, distDirectory, entryKey, federation, errors, applicationName) {
  const closure = collectSynchronousClosure(manifest, entryKey, errors, applicationName);
  if (!closure) return null;

  const federationManifestPath = join(distDirectory, federation.manifest);
  if (!existsSync(federationManifestPath)) {
    errors.push(
      `${applicationName}: missing Federation manifest ${relative(workspaceRoot, federationManifestPath)}`,
    );
    return closure;
  }

  let federationManifest;
  try {
    federationManifest = JSON.parse(readFileSync(federationManifestPath, 'utf8'));
  } catch {
    errors.push(`${applicationName}: Federation manifest ${federation.manifest} is not valid JSON`);
    return closure;
  }

  const matchingExposes = Array.isArray(federationManifest.exposes)
    ? federationManifest.exposes.filter(
        (expose) => expose?.name === federation.expose || expose?.path === `./${federation.expose}`,
      )
    : [];
  if (matchingExposes.length !== 1) {
    errors.push(
      `${applicationName}: Federation expose ${federation.expose} matched ${matchingExposes.length} entries`,
    );
    return closure;
  }

  const expose = matchingExposes[0];
  const synchronousAssets = [...(expose.assets?.js?.sync ?? []), ...(expose.assets?.css?.sync ?? [])];
  const assetToKey = new Map(
    Object.entries(manifest)
      .filter(([, record]) => record.file)
      .map(([key, record]) => [record.file, key]),
  );
  for (const asset of synchronousAssets) {
    const assetPath = join(distDirectory, asset);
    if (!existsSync(assetPath)) {
      errors.push(`${applicationName}: Federation synchronous asset ${asset} is missing`);
      continue;
    }
    closure.assets.add(asset);
    const assetKey = assetToKey.get(asset);
    if (!assetKey) continue;
    const assetClosure = collectSynchronousClosure(manifest, assetKey, errors, applicationName);
    if (!assetClosure) continue;
    for (const key of assetClosure.keys) closure.keys.add(key);
    for (const file of assetClosure.assets) closure.assets.add(file);
  }
  return closure;
}

function collectHtmlClosure(manifest, distDirectory, htmlFile, errors, applicationName) {
  const manifestClosure = collectSynchronousClosure(manifest, htmlFile, errors, applicationName);
  if (!manifestClosure) return null;

  const htmlPath = join(distDirectory, htmlFile);
  if (!existsSync(htmlPath)) {
    errors.push(`${applicationName}: built HTML ${htmlFile} is missing`);
    return null;
  }

  const keys = new Set(manifestClosure.keys);
  const assets = new Set(manifestClosure.assets);
  const assetToKey = new Map(
    Object.entries(manifest)
      .filter(([, record]) => record.file)
      .map(([key, record]) => [record.file, key]),
  );
  const visit = (key) => {
    if (keys.has(key)) return;
    const record = manifest[key];
    if (!record) return;
    keys.add(key);
    if (record.file) assets.add(record.file);
    for (const cssFile of record.css ?? []) assets.add(cssFile);
    for (const dependency of record.imports ?? []) visit(dependency);
  };

  const html = readFileSync(htmlPath, 'utf8');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/giu)) {
    const pathname = new URL(match[1], 'https://bundle.local').pathname.replace(/^\//u, '');
    if (!['.css', '.js'].includes(extname(pathname))) continue;
    assets.add(pathname);
    const key = assetToKey.get(pathname);
    if (key) visit(key);
  }
  return { assets, keys };
}

function findManifestKey(manifest, requestedKey, errors, context) {
  if (manifest[requestedKey]) return requestedKey;
  const sourceMatches = Object.entries(manifest)
    .filter(([, record]) => record.src === requestedKey)
    .map(([key]) => key);
  if (sourceMatches.length === 1) return sourceMatches[0];
  if (sourceMatches.length > 1) {
    errors.push(`${context} ${requestedKey} has ${sourceMatches.length} exact source matches`);
    return undefined;
  }

  // Paths are source contracts and must never fall back to a same-named chunk.
  if (requestedKey.includes('/')) return undefined;
  const nameMatches = Object.entries(manifest)
    .filter(([, record]) => record.name === requestedKey)
    .map(([key]) => key);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    errors.push(`${context} ${requestedKey} has ${nameMatches.length} name matches`);
  }
  return undefined;
}

function measureAssets(distDirectory, assets, extension) {
  let raw = 0;
  let gzip = 0;
  for (const asset of assets) {
    if (extname(asset) !== extension) continue;
    const contents = readFileSync(join(distDirectory, asset));
    raw += contents.byteLength;
    gzip += gzipSync(contents).byteLength;
  }
  return { raw, gzip };
}

function walkAssets(directory) {
  const result = [];
  for (const item of readdirSync(directory)) {
    const absolutePath = join(directory, item);
    if (statSync(absolutePath).isDirectory()) result.push(...walkAssets(absolutePath));
    else if (['.css', '.js'].includes(extname(item))) result.push(absolutePath);
  }
  return result;
}

function largestAsset(distDirectory, assets, extension) {
  let largest = { file: 'none', gzip: 0, raw: 0 };
  for (const absolutePath of assets) {
    if (extname(absolutePath) !== extension) continue;
    const contents = readFileSync(absolutePath);
    if (contents.byteLength <= largest.raw) continue;
    largest = {
      file: relative(distDirectory, absolutePath).replaceAll('\\', '/'),
      gzip: gzipSync(contents).byteLength,
      raw: contents.byteLength,
    };
  }
  return largest;
}

function checkBudget(label, actual, limit) {
  if (limit === undefined || actual <= limit) return;
  failures.push(`${label}: ${actual} B exceeds ${limit} B`);
}

function formatSize(value) {
  return `${(value / 1000).toFixed(2)} kB`;
}

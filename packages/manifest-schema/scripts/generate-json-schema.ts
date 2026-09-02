import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { zodToJsonSchema } from 'zod-to-json-schema';

import { ReleaseManifestSchema } from '../src/index.js';

const outputUrl = new URL('../dist/awesome-workflow-manifest.schema.json', import.meta.url);
const schema = zodToJsonSchema(ReleaseManifestSchema, {
  name: 'AwesomeWorkflowManifest',
  $refStrategy: 'root',
  target: 'jsonSchema7',
});

await mkdir(fileURLToPath(new URL('.', outputUrl)), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

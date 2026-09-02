import { Button } from '@arco-design/web-react';
import { IconLaunch } from '@arco-design/web-react/icon';

import type { CatalogEntry, LinkManifest } from '../types/catalog';

export function LinkRuntime({ entry }: { entry: CatalogEntry & { manifest: LinkManifest } }) {
  return (
    <div className="link-runtime">
      <span>EXTERNAL / NO HOST EXECUTION</span>
      <h2>{entry.name}</h2>
      <p>{entry.summary}</p>
      <code>{entry.manifest.url}</code>
      <Button
        type="primary"
        icon={<IconLaunch />}
        href={entry.manifest.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open external application
      </Button>
    </div>
  );
}

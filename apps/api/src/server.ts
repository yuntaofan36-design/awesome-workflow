import { loadPlatformConfig } from '@awesome-workflow/config';

import { createApiApplication } from './bootstrap.js';

const config = loadPlatformConfig();
const app = await createApiApplication(config);
await app.listen(config.API_PORT, config.API_HOST);

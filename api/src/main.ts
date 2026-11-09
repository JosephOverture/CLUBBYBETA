import { createApplication } from './bootstrap';
import { readConfig } from './platform/config';
import { Database } from './platform/database';

const config = readConfig();
const app = await createApplication(config);
if (!(await app.get(Database).ready())) {
  await app.close();
  throw new Error('Database environment or migrations are not ready.');
}
await app.listen(config.PORT, config.HOST);

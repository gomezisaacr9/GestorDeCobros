// Fail-fast boot: importing env first asserts JWT_SECRET (throws non-zero if
// missing/empty) BEFORE the server starts listening. Must stay the first import.
import { env } from './config/env';
import { createApp } from './app';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`gestionpagos server listening on http://localhost:${env.PORT} (env: ${env.NODE_ENV})`);
});
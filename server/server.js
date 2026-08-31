/* Entry point — `npm start`. */

import { createApp } from "./app.js";

const { server, config } = createApp();

const HOST = config.HOST || "127.0.0.1";
server.listen(config.PORT, HOST, () => {
  process.stdout.write(
    `PromptKey backend listening on http://${HOST}:${config.PORT} ` +
    `(AI_MODE=${config.AI_MODE}, provider=${config.AI_PROVIDER})\n`
  );
});

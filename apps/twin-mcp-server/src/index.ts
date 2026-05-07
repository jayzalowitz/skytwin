import { startMcpServer } from './server.js';
import { createLogger } from '@skytwin/core';

const log = createLogger('twin-mcp-server');
const port = parseInt(process.env['TWIN_MCP_SERVER_PORT'] ?? '4444', 10);

startMcpServer({ port }).then(() => {
  log.info(`Twin MCP server listening on port ${port}`);
}).catch((err) => {
  log.error('Failed to start twin MCP server', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

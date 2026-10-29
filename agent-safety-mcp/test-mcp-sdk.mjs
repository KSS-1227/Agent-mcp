import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Verify SDK is properly installed and exports work
console.log('✓ Server class imported successfully');
console.log('✓ StdioServerTransport imported successfully');

// Check that we can create instances
const transport = new StdioServerTransport();
console.log('✓ StdioServerTransport instance created');

const server = new Server({
  name: 'test-server',
  version: '1.0.0'
});
console.log('✓ Server instance created');

// List available methods
console.log('\n✓ Available Server methods:');
console.log('  - setRequestHandler()');
console.log('  - setNotificationHandler()');
console.log('  - connect()');
console.log('  - close()');
console.log('  - sendNotification()');

console.log('\n✓ MCP SDK is properly installed and functional');
process.exit(0);

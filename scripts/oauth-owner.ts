import { createOwnerPasswordHash } from '../src/server/oauth.js';

const username = process.argv[2]?.trim();
const password = process.env.MCP_OAUTH_OWNER_PASSWORD;

if (!username || !password) {
  console.error('Usage: MCP_OAUTH_OWNER_PASSWORD="..." npm run oauth:owner -- <username>');
  process.exit(1);
}

console.log(`MCP_OAUTH_OWNER_USERNAME=${username}`);
console.log(`MCP_OAUTH_OWNER_PASSWORD_HASH=${createOwnerPasswordHash(password)}`);

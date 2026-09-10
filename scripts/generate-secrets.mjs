import crypto from 'node:crypto';
const token = () => crypto.randomBytes(32).toString('base64url');
console.log(`MCP_API_KEY=${token()}`);
console.log(`AGENT_TOKEN=${token()}`);

import 'dotenv/config';
import { loadOAuthConfig } from '../src/server/oauth.js';

const config = loadOAuthConfig();
if (!config) {
  console.log('OAuth is disabled. Existing API-key authentication remains active.');
  process.exit(0);
}

console.log(`OAuth configuration is valid for issuer ${config.issuerUrl} and resource ${config.resourceUrl}.`);

// Lets Node run the TypeScript sources directly: retries extensionless relative imports with .ts.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(
  'export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(/^[./]/.test(s))return n(s+".ts",c);throw e}}'));

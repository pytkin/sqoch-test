import { fileURLToPath } from 'node:url';
export default {
  input: fileURLToPath(new URL('../../.cache/openapi.json', import.meta.url)),
  output:
    process.env.SQOCH_TYPES_OUTPUT ||
    fileURLToPath(new URL('../../src/api/generated', import.meta.url)),
  plugins: [{ name: '@hey-api/typescript', enums: false }],
};

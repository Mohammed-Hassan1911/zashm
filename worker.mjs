// Cloudflare Workers entrypoint for ZASHM.
// Named test helpers live in src/lib/worker-runtime.mjs: workerd rejects
// non-handler named exports in the entry module, so this file exports only
// the handler object required by the Workers runtime.
import { handleRequest } from './src/lib/worker-runtime.mjs';

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};

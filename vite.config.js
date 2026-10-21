import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In `npm run dev`, serve api/judge.js locally the same way Vercel does in production.
const devApi = () => ({
  name: 'dev-api',
  configureServer(server) {
    server.middlewares.use('/api/judge', async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = raw;
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      const { default: handler } = await server.ssrLoadModule('/api/judge.js');
      await handler(req, res);
    });
  },
});

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [react(), devApi()],
    build: { target: 'es2022' }, // libauth uses top-level await
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  };
});

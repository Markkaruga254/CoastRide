import fastify, { FastifyInstance } from 'fastify';
import { getEnv } from '../config/env.js';
import healthRoutes from './routes/health.js';

export function buildApp(): FastifyInstance {
  const app = fastify({ logger: false });
  app.register(healthRoutes);
  return app;
}

export function listen(port?: number, callback?: (err: Error | null, address: string) => void) {
  const env = getEnv();
  const app = buildApp();
  const target = port ?? env.PORT;
  app.listen({ port: target }, callback ?? (() => {}));
}

const self = new URL(import.meta.url).pathname;
if (process.argv[1] === self) {
  listen();
}

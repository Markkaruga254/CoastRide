import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { getEnv } from '../../config/env.js';
import { verifySecret, maskPhone } from '../../lib/security.js';

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) {
    return false;
  }
  entry.count++;
  return true;
}

const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const env = getEnv();
    const params = request.params as { secret: string };
    const secret = params.secret;
    if (!verifySecret(secret, env.WEBHOOK_SECRET)) {
      return reply.status(404).send();
    }
  });

  app.post('/webhooks/:secret/echo', async (request: FastifyRequest, reply: FastifyReply) => {
    const clientIp = request.ip;
    if (!rateLimit(`echo:${clientIp}`, 60, 60_000)) {
      return reply.status(429).send({ error: 'rate limited' });
    }

    const body = request.body as Record<string, string>;
    const maskedBody = { ...body };
    if (maskedBody.phoneNumber) maskedBody.phoneNumber = maskPhone(maskedBody.phoneNumber);
    if (maskedBody.from) maskedBody.from = maskPhone(maskedBody.from);
    if (maskedBody.to) maskedBody.to = maskPhone(maskedBody.to);

    request.log.debug({ body: maskedBody }, 'echo webhook received');
    return 'ok';
  });
};

export default webhookRoutes;
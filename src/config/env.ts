import { z } from 'zod';

export const forbiddenSecretPatterns = ['change-me', 'REPLACE_ME'];

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
  WEBHOOK_SECRET: z.string().min(24).refine(
    (val) => !forbiddenSecretPatterns.some((p) => val.includes(p)),
    'WEBHOOK_SECRET must not contain placeholder values like "change-me" or "REPLACE_ME"',
  ),
  AT_ENABLED: z.string().transform((v) => v === 'true').default('false'),
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  SEED_DRIVER_PHONES: z.string().default(
    '+254700000001,+254700000002,+254700000003,+254700000004',
  ),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
}).refine(
  (data) => {
    if (data.NODE_ENV === 'production' || data.AT_ENABLED) {
      return !!data.AT_USERNAME && !!data.AT_API_KEY;
    }
    return true;
  },
  { message: 'AT_USERNAME and AT_API_KEY are required when NODE_ENV=production or AT_ENABLED=true', path: ['AT_USERNAME'] },
);

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

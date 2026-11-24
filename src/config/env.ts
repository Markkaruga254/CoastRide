import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
  WEBHOOK_SECRET: z.string().min(24),
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  SEED_DRIVER_PHONES: z.string().default(
    '+254700000001,+254700000002,+254700000003,+254700000004',
  ),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

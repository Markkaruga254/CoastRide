import { z } from 'zod'

export const forbiddenSecretPatterns = ['change-me', 'REPLACE_ME']

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  PORT: z.string().regex(/^\d+$/).transform(Number).default(3000),
  HOST: z.string().default('0.0.0.0'),
  WEBHOOK_SECRET: z.string().min(24).refine(
    (val) => !forbiddenSecretPatterns.some((p) => val.includes(p)),
    'WEBHOOK_SECRET must not contain placeholder values like "change-me" or "REPLACE_ME"',
  ),
  AT_ENABLED: z.string().transform((v) => v === 'true').default(false),
  AT_USERNAME: z.string().optional(),
  AT_API_KEY: z.string().optional(),
  AT_PASSENGER_USSD_CODE: z.string().trim().min(1).default('*384*43639#'),
  AT_DRIVER_USSD_CODE: z.string().trim().min(1).default('*384*78088#'),
  CRON_SECRET: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(24).optional(),
  ),
  OFFER_TIMEOUT_SECONDS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(10))
    .default(180),
  SEED_DRIVER_PHONES: z.string().default(
    '+254700000001,+254700000002,+254700000003,+254700000004',
  ),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
}).refine(
  (data) => {
    if (data.AT_ENABLED) {
      return !!data.AT_USERNAME && !!data.AT_API_KEY;
    }
    return true;
  },
  { message: 'AT_USERNAME and AT_API_KEY are required when AT_ENABLED=true', path: ['AT_USERNAME'] },
);

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}

export function resetEnvForTesting(): void {
  _env = null;
}

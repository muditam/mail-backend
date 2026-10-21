import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url(),
  STALWART_URL: z.string().url(),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_REDIRECT_URI: z.string().url(),
  SESSION_ENCRYPTION_KEY: z.string().min(1),
  SESSION_DB_PATH: z.string().min(1).default('./data/sessions.sqlite'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
});
export type Config = z.infer<typeof schema>;
export function configFrom(env: NodeJS.ProcessEnv): Config {
  const c = schema.parse(env);
  if (Buffer.from(c.SESSION_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  if (new URL(c.STALWART_URL).protocol !== 'https:') throw new Error('STALWART_URL must be HTTPS');
  if (c.NODE_ENV === 'production' && (new URL(c.APP_ORIGIN).protocol !== 'https:' || new URL(c.OAUTH_REDIRECT_URI).protocol !== 'https:')) throw new Error('Production URLs must be HTTPS');
  return c;
}

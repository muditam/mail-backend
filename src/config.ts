import { z } from 'zod';

const schema = z.object({
  INTERNAL_EMAIL_DOMAINS: z.string().default('muditam.com').refine(v => v.split(',').every(d => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(d.trim())), 'Invalid internal domain list').optional(),
  IT_REPORT_EMAIL: z.string().email().optional(),
  STALWART_AUTHSERV_ID: z.string().regex(/^[a-z0-9.-]+$/i).optional(),
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url(),
  STALWART_URL: z.string().url(),
  STALWART_AUTH_URL: z.string().url(),
  STALWART_TOKEN_URL: z.string().url(),
  STALWART_JMAP_SESSION_URL: z.string().url(),
  OAUTH_CLIENT_ID: z.string().min(1),
  OAUTH_REDIRECT_URI: z.string().url(),
  SESSION_ENCRYPTION_KEY: z.string().min(1),
  MONGODB_URI: z.string().refine(v => /^mongodb(\+srv)?:\/\//.test(v), 'MONGODB_URI must be a MongoDB connection URI'),
  MONGODB_DB_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('webmail'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(240).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(72).default(12),
});
export type Config = z.infer<typeof schema>;
export function configFrom(env: NodeJS.ProcessEnv): Config {
  const c = schema.parse(env);
  if (Buffer.from(c.SESSION_ENCRYPTION_KEY, 'base64').length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must be 32 base64-encoded bytes');
  if (new URL(c.STALWART_URL).protocol !== 'https:') throw new Error('STALWART_URL must be HTTPS');
  for (const name of ['STALWART_AUTH_URL','STALWART_TOKEN_URL','STALWART_JMAP_SESSION_URL'] as const) {
    const endpoint = new URL(c[name]);
    if (endpoint.protocol !== 'https:' || endpoint.origin !== new URL(c.STALWART_URL).origin) throw new Error(`${name} must be HTTPS and use the STALWART_URL origin`);
  }
  if (c.NODE_ENV === 'production' && (new URL(c.APP_ORIGIN).protocol !== 'https:' || new URL(c.OAUTH_REDIRECT_URI).protocol !== 'https:')) throw new Error('Production URLs must be HTTPS');
  return c;
}

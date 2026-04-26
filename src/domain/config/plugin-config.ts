import { z } from 'zod';

const keyAuthSchema = z.object({
  method: z.literal('key'),
  privateKeyPath: z.string().min(1),
  passphrase: z.string().optional().default(''),
});

const passwordAuthSchema = z.object({
  method: z.literal('password'),
  password: z.string().min(1),
});

const agentAuthSchema = z.object({
  method: z.literal('agent'),
});

export const sshAuthSchema = z.discriminatedUnion('method', [keyAuthSchema, passwordAuthSchema, agentAuthSchema]);

export const sshConnectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
  auth: sshAuthSchema,
  connectTimeoutMs: z.number().int().positive().max(60_000).default(10_000),
  keepaliveIntervalMs: z.number().int().min(0).max(300_000).default(30_000),
  /** 0 = never disconnect (default — common for always-on hosts). > 0 = close after this many ms idle. */
  idleDisconnectMs: z.number().int().min(0).max(86_400_000).default(0),
});

export const hostSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i, 'host id must be alphanumeric with dashes'),
  ssh: sshConnectionSchema,
});

export type SshAuthConfig = z.infer<typeof sshAuthSchema>;
export type SshConnectionConfig = z.infer<typeof sshConnectionSchema>;
export type HostConfig = z.infer<typeof hostSchema>;

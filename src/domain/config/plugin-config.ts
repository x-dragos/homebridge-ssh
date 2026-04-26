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

const matchModeSchema = z.enum(['exact', 'contains', 'regex']);

const matchRuleSchema = z.object({
  match: z.string().min(1),
  mode: matchModeSchema,
});

const commandSpecSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120_000),
  expectExitCode: z.number().int().min(0).optional(),
});

const garageStateMappingSchema = z.object({
  open: matchRuleSchema,
  closed: matchRuleSchema,
  opening: matchRuleSchema.optional(),
  closing: matchRuleSchema.optional(),
});

const garageTimingSchema = z.object({
  openTravelTimeMs: z.number().int().min(0).max(120_000).default(0),
  closeTravelTimeMs: z.number().int().min(0).max(120_000).default(0),
  autoCloseTimeoutMs: z.number().int().min(0).max(86_400_000).default(0),
  statePollIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
});

const garageDoorAccessorySchema = z
  .object({
    type: z.literal('garageDoor'),
    name: z.string().min(1),
    host: z.string().min(1),
    commands: z.object({
      open: commandSpecSchema,
      close: commandSpecSchema,
      state: commandSpecSchema.optional(),
    }),
    stateMapping: garageStateMappingSchema.optional(),
    timing: garageTimingSchema.default({
      openTravelTimeMs: 0,
      closeTravelTimeMs: 0,
      autoCloseTimeoutMs: 0,
      statePollIntervalMs: 0,
    }),
  })
  .superRefine((value, ctx) => {
    if (value.commands.state && !value.stateMapping) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stateMapping'],
        message: 'stateMapping is required when commands.state is provided',
      });
    }
    if (value.timing.statePollIntervalMs > 0 && !value.commands.state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commands', 'state'],
        message: 'commands.state is required when timing.statePollIntervalMs > 0',
      });
    }
  });

const switchBehaviorSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('stateful') }),
  z.object({ mode: z.literal('momentary'), autoResetMs: z.number().int().min(50).max(60_000).default(1000) }),
]);

const onOffStateSchema = z.object({
  command: commandSpecSchema,
  onValue: z.string().min(1),
  matchMode: matchModeSchema.default('exact'),
  pollIntervalMs: z.number().int().min(0).max(3_600_000).default(0),
});

const switchAccessorySchema = z.object({
  type: z.literal('switch'),
  name: z.string().min(1),
  host: z.string().min(1),
  commands: z.object({
    on: commandSpecSchema,
    off: commandSpecSchema.optional(),
  }),
  state: onOffStateSchema.optional(),
  behavior: switchBehaviorSchema.default({ mode: 'stateful' }),
});

export const accessoryItemSchema = z.union([garageDoorAccessorySchema, switchAccessorySchema]);

export const pluginConfigSchema = z
  .object({
    platform: z.literal('HomebridgeSsh'),
    name: z.string().min(1),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    hosts: z.array(hostSchema).min(1),
    accessories: z.array(accessoryItemSchema),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.hosts.map((h) => h.id));
    if (ids.size !== value.hosts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hosts'],
        message: 'host ids must be unique',
      });
    }
    value.accessories.forEach((acc, idx) => {
      if (!ids.has(acc.host)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accessories', idx, 'host'],
          message: `accessory references unknown host id "${acc.host}"`,
        });
      }
    });
  });

export type PluginConfig = z.infer<typeof pluginConfigSchema>;
export type AccessoryConfig = z.infer<typeof accessoryItemSchema>;
export type SwitchAccessoryConfig = z.infer<typeof switchAccessorySchema>;
export type GarageDoorAccessoryConfig = z.infer<typeof garageDoorAccessorySchema>;
export type GarageStateMapping = z.infer<typeof garageStateMappingSchema>;
export type CommandSpecConfig = z.infer<typeof commandSpecSchema>;

import { describe, expect, it } from 'vitest';
import { pluginConfigSchema, type PluginConfig } from '../../../src/domain/config/plugin-config.js';
import { validatePluginConfig } from '../../../src/domain/config/validate.js';
import { FakeLogger } from '../../support/fake-logger.js';

const validHost = {
  id: 'gate-pi',
  ssh: {
    host: '192.0.2.10',
    port: 22,
    user: 'pi',
    auth: { method: 'key', privateKeyPath: '/etc/keys/id_ed25519' },
  },
};

const validGarage = {
  type: 'garageDoor',
  name: 'Front Gate',
  host: 'gate-pi',
  commands: {
    open: { command: '/usr/local/bin/gate-open.sh', timeoutMs: 5000 },
    close: { command: '/usr/local/bin/gate-close.sh', timeoutMs: 5000 },
  },
};

const validSwitchStateful = {
  type: 'switch',
  name: 'Reboot',
  host: 'gate-pi',
  commands: { on: { command: 'sudo /sbin/reboot', timeoutMs: 5000 } },
};

const validSwitchMomentary = {
  type: 'switch',
  name: 'Trigger',
  host: 'gate-pi',
  commands: { on: { command: 'sudo /sbin/reboot', timeoutMs: 5000 } },
  behavior: { mode: 'momentary', autoResetMs: 1000 },
};

describe('pluginConfigSchema', () => {
  it('accepts a minimal valid config with both types', () => {
    const parsed: PluginConfig = pluginConfigSchema.parse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [validGarage, validSwitchStateful, validSwitchMomentary],
    });
    expect(parsed.hosts).toHaveLength(1);
    expect(parsed.accessories).toHaveLength(3);
  });

  it('defaults logLevel to info', () => {
    const parsed = pluginConfigSchema.parse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [],
    });
    expect(parsed.logLevel).toBe('info');
  });

  it('rejects accessory referencing unknown host', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [{ ...validGarage, host: 'nope' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects garageDoor with statePollIntervalMs > 0 and no state command', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [
        {
          ...validGarage,
          timing: {
            openTravelTimeMs: 15000,
            closeTravelTimeMs: 15000,
            autoCloseTimeoutMs: 0,
            statePollIntervalMs: 30000,
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts garageDoor stateMapping with only open and closed (opening/closing optional)', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [
        {
          ...validGarage,
          commands: {
            ...validGarage.commands,
            state: { command: '/usr/local/bin/gate-state.sh', timeoutMs: 3000 },
          },
          stateMapping: {
            open: { match: 'OPEN', mode: 'exact' },
            closed: { match: 'CLOSED', mode: 'exact' },
          },
          timing: {
            openTravelTimeMs: 15000,
            closeTravelTimeMs: 15000,
            autoCloseTimeoutMs: 0,
            statePollIntervalMs: 30000,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts switch momentary even when commands.off is set (warning is handled at validate layer, not zod)', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [validHost],
      accessories: [
        {
          ...validSwitchMomentary,
          commands: {
            on: { command: 'on', timeoutMs: 1000 },
            off: { command: 'off', timeoutMs: 1000 },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects key auth without privateKeyPath', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [{ ...validHost, ssh: { ...validHost.ssh, auth: { method: 'key' } } }],
      accessories: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects password auth without password', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [{ ...validHost, ssh: { ...validHost.ssh, auth: { method: 'password' } } }],
      accessories: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts agent auth with no extra fields', () => {
    const result = pluginConfigSchema.safeParse({
      platform: 'HomebridgeSsh',
      name: 'SSH Bridge',
      hosts: [{ ...validHost, ssh: { ...validHost.ssh, auth: { method: 'agent' } } }],
      accessories: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('validatePluginConfig', () => {
  const baseHost = {
    id: 'gate-pi',
    ssh: {
      host: '192.0.2.10',
      port: 22,
      user: 'pi',
      auth: { method: 'key', privateKeyPath: '/k' },
    },
  };

  it('passes through fully-valid config unchanged', () => {
    const result = validatePluginConfig(
      {
        platform: 'HomebridgeSsh',
        name: 'SSH Bridge',
        hosts: [baseHost],
        accessories: [
          {
            type: 'switch',
            name: 'Reboot',
            host: 'gate-pi',
            commands: { on: { command: 'true', timeoutMs: 1000 }, off: { command: 'true', timeoutMs: 1000 } },
            behavior: { mode: 'stateful' },
          },
        ],
      },
      new FakeLogger(),
    );
    expect(result.fatalErrors).toEqual([]);
    expect(result.skippedAccessories).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config?.accessories).toHaveLength(1);
  });

  it('isolates a bad accessory and keeps the rest', () => {
    const logger = new FakeLogger();
    const result = validatePluginConfig(
      {
        platform: 'HomebridgeSsh',
        name: 'SSH Bridge',
        hosts: [baseHost],
        accessories: [
          {
            type: 'switch',
            name: 'Reboot',
            host: 'gate-pi',
            commands: { on: { command: 'true', timeoutMs: 1000 }, off: { command: 'true', timeoutMs: 1000 } },
            behavior: { mode: 'stateful' },
          },
          { type: 'switch', name: 'Bad', host: 'unknown-host', commands: { on: { command: 'x', timeoutMs: 1000 } } },
        ],
      },
      logger,
    );
    expect(result.fatalErrors).toEqual([]);
    expect(result.config?.accessories).toHaveLength(1);
    expect(result.skippedAccessories).toHaveLength(1);
    expect(logger.entries.some((e) => e.level === 'error' && e.message.includes('skipping'))).toBe(true);
  });

  it('warns when stateful switch has no commands.off', () => {
    const logger = new FakeLogger();
    const result = validatePluginConfig(
      {
        platform: 'HomebridgeSsh',
        name: 'SSH Bridge',
        hosts: [baseHost],
        accessories: [
          {
            type: 'switch',
            name: 'Reboot',
            host: 'gate-pi',
            commands: { on: { command: 'true', timeoutMs: 1000 } },
            behavior: { mode: 'stateful' },
          },
        ],
      },
      logger,
    );
    expect(result.warnings.some((w) => w.includes('no commands.off'))).toBe(true);
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('no commands.off'))).toBe(true);
  });

  it('warns when momentary switch has commands.off (does not reject)', () => {
    const logger = new FakeLogger();
    const result = validatePluginConfig(
      {
        platform: 'HomebridgeSsh',
        name: 'SSH Bridge',
        hosts: [baseHost],
        accessories: [
          {
            type: 'switch',
            name: 'Trigger',
            host: 'gate-pi',
            commands: { on: { command: 'true', timeoutMs: 1000 }, off: { command: 'true', timeoutMs: 1000 } },
            behavior: { mode: 'momentary', autoResetMs: 1000 },
          },
        ],
      },
      logger,
    );
    expect(result.config?.accessories).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('unused in momentary mode'))).toBe(true);
  });

  it('returns fatal errors when platform-level config is broken', () => {
    const result = validatePluginConfig(
      { platform: 'WrongName', name: 'x', hosts: [], accessories: [] },
      new FakeLogger(),
    );
    expect(result.config).toBeNull();
    expect(result.fatalErrors.length).toBeGreaterThan(0);
  });
});

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { HomebridgeLogger, type LogLevel } from './adapters/homebridge-logger.js';
import { HomebridgeSwitchAccessory } from './adapters/homebridge/switch-accessory.js';
import { SshConnectionPool } from './adapters/ssh/ssh-connection-pool.js';
import { SystemClock } from './adapters/system-clock.js';
import { validatePluginConfig } from './domain/config/validate.js';
import type { AccessoryConfig, HostConfig, PluginConfig } from './domain/config/plugin-config.js';
import type { Logger } from './domain/ports/logger.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class HomebridgeSshPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly logger: Logger;
  private readonly clock = new SystemClock();
  private readonly pool: SshConnectionPool;
  private validatedConfig: PluginConfig | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    const requestedLevel = (config.logLevel as LogLevel | undefined) ?? 'info';
    this.logger = new HomebridgeLogger(log, requestedLevel).child({ plugin: PLUGIN_NAME });
    this.pool = new SshConnectionPool(this.logger);

    try {
      const result = validatePluginConfig(config, this.logger);
      if (result.config === null) {
        this.logger.error('plugin config invalid — accessories will not load', undefined, {
          errors: result.fatalErrors,
        });
      } else {
        this.validatedConfig = result.config;
        if (result.skippedAccessories.length > 0) {
          this.logger.warn('skipped invalid accessories', { count: result.skippedAccessories.length });
        }
      }
    } catch (err) {
      this.logger.error('unexpected error while validating config', err);
    }

    this.api.on('didFinishLaunching', () => {
      try {
        this.logger.info('launching', { accessoryCount: this.validatedConfig?.accessories.length ?? 0 });
        this.discoverDevices();
      } catch (err) {
        this.logger.error('discoverDevices failed', err);
      }
    });
    this.api.on('shutdown', () => {
      this.logger.info('shutting down');
      this.pool.closeAll().catch((err) => this.logger.error('error closing ssh pool', err));
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverDevices(): void {
    if (!this.validatedConfig) {
      return;
    }
    const cfg = this.validatedConfig;
    const hostsById = new Map<string, HostConfig>(cfg.hosts.map((h) => [h.id, h]));
    const successfullyBoundUuids = new Set<string>();

    for (const accessory of cfg.accessories) {
      const host = hostsById.get(accessory.host);
      if (!host) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`${host.id}:${accessory.type}:${accessory.name}`);
      const cached = this.accessories.get(uuid);
      const platformAccessory = cached ?? new this.api.platformAccessory(accessory.name, uuid);
      platformAccessory.context.config = accessory;

      try {
        this.bindAccessory(platformAccessory, accessory, host);
      } catch (err) {
        this.logger.error('failed to bind accessory', err, { name: accessory.name, type: accessory.type });
        continue;
      }
      // Only mark as "seen" after successful bind (F-12 fix: failed accessories get cleaned up).
      successfullyBoundUuids.add(uuid);

      if (!cached) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
        this.accessories.set(uuid, platformAccessory);
        this.logger.info('accessory registered', { name: accessory.name, type: accessory.type, uuid });
      } else {
        this.api.updatePlatformAccessories([platformAccessory]);
      }
    }

    const orphaned: { uuid: string; accessory: PlatformAccessory }[] = [];
    for (const [uuid, accessory] of this.accessories) {
      if (!successfullyBoundUuids.has(uuid)) {
        orphaned.push({ uuid, accessory });
      }
    }
    for (const { uuid, accessory } of orphaned) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.logger.info('accessory unregistered', { name: accessory.displayName, uuid });
    }
  }

  private bindAccessory(accessory: PlatformAccessory, config: AccessoryConfig, host: HostConfig): void {
    const childLogger = this.logger.child({ host: host.id, accessory: config.name });
    const runner = this.pool.get(host);
    if (config.type === 'switch') {
      new HomebridgeSwitchAccessory(this, accessory, config, runner, this.clock, childLogger);
      return;
    }
    // Routed through the F-12 cleanup path: an unimplemented type must NOT survive
    // the orphan sweep as a ghost accessory in HomeKit.
    throw new Error(`accessory type "${config.type}" is not yet implemented`);
  }
}

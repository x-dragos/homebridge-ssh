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
import { SshConnectionPool } from './adapters/ssh/ssh-connection-pool.js';
import { SystemClock } from './adapters/system-clock.js';
import type { Logger } from './domain/ports/logger.js';
import { PLUGIN_NAME } from './settings.js';

export class HomebridgeSshPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly logger: Logger;
  private readonly clock = new SystemClock();
  private readonly pool: SshConnectionPool;

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

    this.api.on('didFinishLaunching', () => {
      try {
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

  /** Phase 1: empty discovery. T21 (Phase 2) replaces this whole file with the version that
   *  validates config and binds accessories — there's no subclassing, just a file replacement. */
  private discoverDevices(): void {
    this.logger.info('launching', { accessoryCount: 0 });
  }
}

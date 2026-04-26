import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { HomebridgeSshPlatform } from '../../platform.js';
import { SwitchOrchestrator } from '../../domain/orchestrators/switch-orchestrator.js';
import { OnOffParser } from '../../domain/parsers/on-off-parser.js';
import type { CommandRunner } from '../../domain/ports/command-runner.js';
import type { Logger } from '../../domain/ports/logger.js';
import type { Clock } from '../../domain/ports/clock.js';
import type { SwitchAccessoryConfig } from '../../domain/config/plugin-config.js';

export class HomebridgeSwitchAccessory {
  private readonly service: Service;
  private readonly orchestrator: SwitchOrchestrator;

  constructor(
    private readonly platform: HomebridgeSshPlatform,
    accessory: PlatformAccessory,
    config: SwitchAccessoryConfig,
    runner: CommandRunner,
    clock: Clock,
    logger: Logger,
  ) {
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-ssh')
      .setCharacteristic(this.platform.Characteristic.Model, 'SSH Switch')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.UUID);

    this.service =
      accessory.getService(this.platform.Service.Switch) ?? accessory.addService(this.platform.Service.Switch);
    this.service.setCharacteristic(this.platform.Characteristic.Name, config.name);

    this.orchestrator = new SwitchOrchestrator({
      runner,
      clock,
      logger,
      onStateChange: (on) => this.service.updateCharacteristic(this.platform.Characteristic.On, on),
      onCommand: config.commands.on,
      ...(config.commands.off ? { offCommand: config.commands.off } : {}),
      mode: config.behavior.mode,
      ...(config.behavior.mode === 'momentary' ? { autoResetMs: config.behavior.autoResetMs } : {}),
      ...(config.state
        ? {
            stateCommand: config.state.command,
            stateParser: new OnOffParser({ onValue: config.state.onValue, mode: config.state.matchMode }),
            statePollIntervalMs: config.state.pollIntervalMs,
          }
        : {}),
    });

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.onSet.bind(this))
      .onGet(() => this.orchestrator.isOn());

    this.orchestrator.start();
  }

  private async onSet(value: CharacteristicValue): Promise<void> {
    try {
      await this.orchestrator.setOn(Boolean(value));
    } catch {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}

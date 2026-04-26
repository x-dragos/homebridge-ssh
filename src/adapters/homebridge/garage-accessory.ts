import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { HomebridgeSshPlatform } from '../../platform.js';
import { GarageOrchestrator, type DoorTarget } from '../../domain/orchestrators/garage-orchestrator.js';
import { GarageStateParser } from '../../domain/parsers/garage-state-parser.js';
import { DoorState } from '../../domain/orchestrators/door-state.js';
import type { CommandRunner } from '../../domain/ports/command-runner.js';
import type { Logger } from '../../domain/ports/logger.js';
import type { Clock } from '../../domain/ports/clock.js';
import type { GarageDoorAccessoryConfig } from '../../domain/config/plugin-config.js';

export class HomebridgeGarageAccessory {
  private readonly service: Service;
  private readonly orchestrator: GarageOrchestrator;

  constructor(
    private readonly platform: HomebridgeSshPlatform,
    accessory: PlatformAccessory,
    config: GarageDoorAccessoryConfig,
    runner: CommandRunner,
    clock: Clock,
    logger: Logger,
  ) {
    accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'homebridge-ssh')
      .setCharacteristic(this.platform.Characteristic.Model, 'SSH Garage Door')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.UUID);

    this.service =
      accessory.getService(this.platform.Service.GarageDoorOpener) ??
      accessory.addService(this.platform.Service.GarageDoorOpener);
    this.service.setCharacteristic(this.platform.Characteristic.Name, config.name);
    this.service.setCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    this.orchestrator = new GarageOrchestrator({
      runner,
      clock,
      logger,
      onChange: (current, target) => this.publish(current, target),
      openCommand: config.commands.open,
      closeCommand: config.commands.close,
      ...(config.commands.state && config.stateMapping
        ? {
            stateCommand: config.commands.state,
            stateParser: new GarageStateParser(config.stateMapping),
          }
        : {}),
      timing: config.timing,
    });

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onSet(this.onSetTarget.bind(this))
      .onGet(() => this.targetToHomeKit(this.orchestrator.target()));
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(() => this.currentToHomeKit(this.orchestrator.current()));

    this.publish(this.orchestrator.current(), this.orchestrator.target());
    this.orchestrator.start();
  }

  private async onSetTarget(value: CharacteristicValue): Promise<void> {
    const target: DoorTarget = value === this.platform.Characteristic.TargetDoorState.OPEN ? 'open' : 'closed';
    try {
      await this.orchestrator.setTarget(target);
    } catch {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private publish(current: DoorState, target: DoorTarget): void {
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.currentToHomeKit(current));
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.targetToHomeKit(target));
  }

  private currentToHomeKit(state: DoorState): number {
    const ch = this.platform.Characteristic.CurrentDoorState;
    switch (state) {
      case DoorState.Open:
        return ch.OPEN;
      case DoorState.Closed:
        return ch.CLOSED;
      case DoorState.Opening:
        return ch.OPENING;
      case DoorState.Closing:
        return ch.CLOSING;
      case DoorState.Stopped:
        return ch.STOPPED;
    }
  }

  private targetToHomeKit(target: DoorTarget): number {
    const ch = this.platform.Characteristic.TargetDoorState;
    return target === 'open' ? ch.OPEN : ch.CLOSED;
  }
}

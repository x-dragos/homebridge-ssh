import type { ZodError, ZodIssue } from 'zod';
import type { Logger } from '../ports/logger.js';
import {
  accessoryItemSchema,
  pluginConfigSchema,
  type AccessoryConfig,
  type HostConfig,
  type PluginConfig,
} from './plugin-config.js';

export interface ValidationResult {
  /** When non-null, the platform-level config is usable. Per-accessory failures surfaced via skippedAccessories. */
  config: PluginConfig | null;
  skippedAccessories: { index: number; reason: string }[];
  warnings: string[];
  fatalErrors: string[];
}

function collectWarnings(config: PluginConfig): string[] {
  const warnings: string[] = [];
  config.accessories.forEach((acc, idx) => {
    if (acc.type === 'switch') {
      if (acc.behavior.mode === 'stateful' && !acc.commands.off) {
        warnings.push(
          `accessories[${idx}] (${acc.name}): stateful switch has no commands.off — turning off will be a no-op (state-only flip)`,
        );
      }
      if (acc.behavior.mode === 'momentary' && acc.commands.off) {
        warnings.push(
          `accessories[${idx}] (${acc.name}): commands.off is unused in momentary mode and will be ignored`,
        );
      }
    }
  });
  return warnings;
}

function hostExists(hosts: HostConfig[], id: string): boolean {
  return hosts.some((h) => h.id === id);
}

function zodToMessages(error: ZodError): string[] {
  const out: string[] = [];
  const visit = (issues: ZodIssue[]): void => {
    for (const issue of issues) {
      // z.union failures wrap the per-branch errors; flatten them so the user
      // sees the actual missing/invalid fields instead of "<root>: Invalid input".
      if (issue.code === 'invalid_union') {
        for (const sub of issue.unionErrors) {
          visit(sub.issues);
        }
        continue;
      }
      const path = issue.path.join('.') || '<root>';
      out.push(`${path}: ${issue.message}`);
    }
  };
  visit(error.issues);
  return [...new Set(out)];
}

export function validatePluginConfig(raw: unknown, logger: Logger): ValidationResult {
  const strict = pluginConfigSchema.safeParse(raw);
  if (strict.success) {
    const warnings = collectWarnings(strict.data);
    warnings.forEach((w) => logger.warn(w));
    return { config: strict.data, skippedAccessories: [], warnings, fatalErrors: [] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: null, skippedAccessories: [], warnings: [], fatalErrors: ['plugin config must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  const skeleton = { ...obj, accessories: [] };
  const skeletonResult = pluginConfigSchema.safeParse(skeleton);
  if (!skeletonResult.success) {
    return {
      config: null,
      skippedAccessories: [],
      warnings: [],
      fatalErrors: zodToMessages(skeletonResult.error),
    };
  }

  const accessories = Array.isArray(obj.accessories) ? obj.accessories : [];
  const accepted: AccessoryConfig[] = [];
  const skipped: { index: number; reason: string }[] = [];
  for (let i = 0; i < accessories.length; i++) {
    const item = accessories[i];
    const itemResult = accessoryItemSchema.safeParse(item);
    if (itemResult.success && hostExists(skeletonResult.data.hosts, itemResult.data.host)) {
      accepted.push(itemResult.data);
    } else {
      const reason = itemResult.success
        ? `references unknown host id "${itemResult.data.host}"`
        : zodToMessages(itemResult.error).join('; ');
      skipped.push({ index: i, reason });
      logger.error('skipping invalid accessory', undefined, { index: i, reason });
    }
  }

  const validated: PluginConfig = { ...skeletonResult.data, accessories: accepted };
  const warnings = collectWarnings(validated);
  warnings.forEach((w) => logger.warn(w));

  return {
    config: validated,
    skippedAccessories: skipped,
    warnings,
    fatalErrors: [],
  };
}

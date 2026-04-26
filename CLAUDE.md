# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commit and PR style

- **Never** add `Co-Authored-By: Claude`, `Generated with Claude Code`, or any other AI/tooling attribution to commit messages, PR titles, or PR bodies.
- **No emojis** anywhere in commit messages, PR titles, or PR descriptions.
- Subject lines: imperative mood, terse, professional. Body (when needed): focus on the _why_, not the _what_.

## Project

`homebridge-ssh` — a Homebridge dynamic platform plugin that exposes remote shell scripts (run over SSH) as native HomeKit accessories. v1 supports `switch` and `garageDoor` accessory types. Spec: `docs/superpowers/specs/2026-04-26-homebridge-ssh-design.md` (gitignored). Implementation plan: `docs/superpowers/plans/` (gitignored).

## Homebridge Verified Plugin rules — MUST follow

These come from <https://github.com/homebridge/plugins> ("Verified by Homebridge" requirements, last updated 2024-11-02). Treat them as non-negotiable:

- **Plugin type:** dynamic platform (not accessory plugin).
- **Node.js:** must run on supported LTS — currently **v20, v22, v24**. CI matrix and `package.json#engines.node` must reflect this.
- **Boot behaviour:** the plugin must successfully install and **not start unless it is configured**. With no platform entry in `config.json`, no accessories should be registered and no errors thrown.
- **Install scripts:** **no** post-install scripts that modify the user's system. Don't add `postinstall` or similar to `package.json`.
- **TTY / startup:** must not require Homebridge to run in a TTY or with non-standard startup parameters.
- **Settings GUI:** must implement the [Homebridge Plugin Settings GUI](https://developers.homebridge.io/#/config-schema) via a complete `config.schema.json`.
- **Privacy:** zero analytics, zero user-tracking calls.
- **File storage:** any files written to disk (cache, keys, etc.) go inside the Homebridge storage directory (resolved via `api.user.storagePath()`). Never `~/` or `/tmp/`.
- **Errors:** **must not throw unhandled exceptions.** Catch and log own errors. Per-accessory failures must not crash the platform — isolate them.
- **Releases:** every published version gets a GitHub release with notes (Phase 4 polish item).

## Architecture (hexagonal — ports & adapters)

The codebase splits into a pure **domain core** and impure **adapters**. Domain depends on abstract ports only; adapters implement ports against real libraries.

```
src/
├── domain/                 PURE — no homebridge, ssh2, or node:* imports
│   ├── ports/              CommandRunner, Clock, Logger interfaces
│   ├── command/            CommandSpec, CommandResult, typed errors
│   ├── parsers/            stdout → state mappings
│   ├── orchestrators/      switch + garage door state machines
│   └── config/             zod schemas + per-accessory validation
└── adapters/               impure — implement ports
    ├── ssh/                ssh2-backed CommandRunner + connection pool
    ├── homebridge-logger.ts
    ├── system-clock.ts
    └── homebridge/         binds HomeKit Service/Characteristic ↔ orchestrators
```

### Hard rule (lint-enforced)

Nothing under `src/domain/**` may import from `homebridge`, `ssh2`, or `node:*` built-ins (`fs`, `path`, `crypto`, etc.). Enforced by `no-restricted-imports` in `eslint.config.js` scoped to `src/domain/**`. If a domain file needs side-effects, that's a signal it should be calling a port — never break the rule.

### Composition root

`src/platform.ts` is the only place where adapters are wired to the domain. New accessory types are added by:

1. Adding a new orchestrator under `src/domain/orchestrators/`.
2. Adding a new HomeKit adapter under `src/adapters/homebridge/`.
3. Extending the discriminated-union schema in `src/domain/config/plugin-config.ts`.
4. Adding a branch in `platform.ts#bindAccessory`.

No other file should change.

## Module system

`package.json` declares `"type": "module"`. **Internal imports must include the `.js` extension** even though source is `.ts` (e.g., `import { PLATFORM_NAME } from './settings.js'`). Required for Node's ESM resolver at runtime.

## Tooling

- **ESLint** owns code-quality rules (TS-specific lints, `no-restricted-imports` for the domain layer).
- **Prettier** owns all formatting (single quotes, semis, 120-char lines, trailing commas). `eslint-config-prettier` disables every conflicting ESLint rule. Do not run Prettier as an ESLint plugin.
- **Vitest** for tests. Domain tests use `FakeCommandRunner`, `FakeClock`, `FakeLogger` from `test/support/`. No real timers, no real SSH, no real Homebridge in domain tests.
- **simple-git-hooks** registers `bin/pre-commit.sh`, which scans staged content for IPv4 patterns and private-key markers (override with `git commit --no-verify` for legitimate exceptions).

## Stable identifiers

Accessory UUIDs are derived from `${host.id}:${type}:${name}` and generated via `api.hap.uuid.generate(...)`. Renaming an accessory in config will create a new UUID and orphan the old cached accessory — that's expected behaviour; the orphan cleanup pass in `discoverDevices()` will remove it on next start.

## Dev workflow (Mac → Pi)

This codebase is developed on a Mac. Homebridge runs on Pi A; the gate-controller scripts run on Pi B (a separate Pi reachable from Pi A via SSH).

- **Iterate locally:** `npm test` (vitest). Domain logic is fully covered with fakes — no SSH, no Homebridge, no Pi required.
- **Validate on Pi A:** `npm run deploy:pi` builds, packs, scps the tarball to `$PI_HOST` (from `.env.local`), installs globally, restarts Homebridge (auto-detects `hb-service` vs `systemctl`).
- **Tail logs from Mac:** `npm run logs:pi`.
- **Quick SSH sanity:** `npm run test:ssh -- "uptime"`.
- **`.env.local` is gitignored.** Copy `.env.example`, fill in real values.

## Repo hygiene

The pre-commit hook + `.gitignore` together enforce that **no host/user/IP/secret values land in committed code.** Anything host-specific lives in `.env.local` or `test/hbConfig/config.local.json`, both of which are gitignored. The committed `test/hbConfig/config.json` contains placeholder values.

## TDD discipline

Domain modules are built test-first:

1. Write a failing test that names the desired behaviour.
2. Run it, confirm the failure mode (module-not-found or specific assertion).
3. Implement the minimum code to make it pass.
4. Run tests again, confirm green.
5. Commit.

Don't batch test + implementation in a single commit when you can avoid it — small, focused commits make bisecting easier.

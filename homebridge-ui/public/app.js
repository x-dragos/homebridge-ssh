/* eslint-env browser */
/* global homebridge */
//
// homebridge-ssh custom UI controller. Vanilla JS, Bootstrap 5 classes from the host UI.
//
// Single in-memory model {name, logLevel, hosts:[], accessories:[]} drives the rendering;
// every input mutates the model, and a debounced updatePluginConfig syncs to Homebridge.
// The serializer prunes empty optional sub-objects so config.json never contains
// half-filled blocks (e.g. commands.off: { timeoutMs: 5000 }).
(() => {
  // Mirror the parent Homebridge UI's theme so our form-controls render correctly.
  // Bootstrap 5 picks up data-bs-theme; we also drop a fallback class for our own CSS.
  function syncTheme() {
    let dark = false;
    try {
      const parentBody = window.parent && window.parent.document && window.parent.document.body;
      if (parentBody && parentBody.classList && parentBody.classList.contains('dark-mode')) {
        dark = true;
      }
    } catch {
      dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.dataset.bsTheme = dark ? 'dark' : 'light';
    document.documentElement.classList.toggle('dark-mode', dark);
  }
  syncTheme();
  // Re-check periodically in case the user toggles theme while the modal is open.
  setInterval(syncTheme, 2000);

  const PLATFORM = 'HomebridgeSsh';
  const DEFAULT_NAME = 'SSH Bridge';
  const DEFAULT_LOG_LEVEL = 'info';
  const SAVE_DEBOUNCE_MS = 250;

  let model = newModel();

  function newModel() {
    return { name: DEFAULT_NAME, logLevel: DEFAULT_LOG_LEVEL, hosts: [], accessories: [] };
  }

  function uid() {
    return Math.random().toString(36).slice(2, 9);
  }

  // ----- DOM helpers -----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function instantiate(tmplId) {
    const tmpl = document.getElementById(tmplId);
    return tmpl.content.firstElementChild.cloneNode(true);
  }
  function toggleHidden(el, hidden) {
    el.classList.toggle('d-none', hidden);
  }
  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  // ----- Debounced sync -----
  let syncTimer = null;
  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(syncToHomebridge, SAVE_DEBOUNCE_MS);
  }
  async function syncToHomebridge() {
    syncTimer = null;
    try {
      await homebridge.updatePluginConfig([toEmittable(model)]);
    } catch (err) {
      console.error('updatePluginConfig failed', err);
    }
  }

  // ----- Serializer: emit only fields the user actually touched -----
  function nonEmpty(s) {
    return typeof s === 'string' && s.trim() !== '';
  }
  function asInt(v) {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  function commandFrom(b) {
    if (!nonEmpty(b.command)) return null;
    const out = { command: b.command };
    const t = asInt(b.timeoutMs);
    if (t !== undefined) out.timeoutMs = t;
    return out;
  }
  function matchRuleFrom(b) {
    if (!nonEmpty(b.match) || !nonEmpty(b.mode)) return null;
    return { match: b.match, mode: b.mode };
  }

  function emitHost(h) {
    const ssh = { host: h.host, user: h.user, auth: { method: h.auth.method } };
    const port = asInt(h.port);
    if (port !== undefined) ssh.port = port;
    if (h.auth.method === 'key') {
      if (nonEmpty(h.auth.privateKeyPath)) ssh.auth.privateKeyPath = h.auth.privateKeyPath;
      if (nonEmpty(h.auth.passphrase)) ssh.auth.passphrase = h.auth.passphrase;
    } else if (h.auth.method === 'password') {
      if (nonEmpty(h.auth.password)) ssh.auth.password = h.auth.password;
    }
    const ct = asInt(h.connectTimeoutMs);
    if (ct !== undefined) ssh.connectTimeoutMs = ct;
    const ka = asInt(h.keepaliveIntervalMs);
    if (ka !== undefined) ssh.keepaliveIntervalMs = ka;
    const id = asInt(h.idleDisconnectMs);
    if (id !== undefined) ssh.idleDisconnectMs = id;
    return { id: h.id, ssh };
  }

  function emitAccessory(a) {
    const out = { type: a.type, name: a.name, host: a.host, commands: {} };

    if (a.type === 'switch') {
      const on = commandFrom(a.commands.on);
      if (on) out.commands.on = on;
      if (a.hasOff) {
        const off = commandFrom(a.commands.off);
        if (off) out.commands.off = off;
      }
      if (a.hasState) {
        const state = commandFrom(a.commands.state);
        if (state) out.commands.state = state;
      }
      const behavior = { mode: a.behavior.mode };
      if (a.behavior.mode === 'momentary') {
        const ar = asInt(a.behavior.autoResetMs);
        if (ar !== undefined) behavior.autoResetMs = ar;
      }
      out.behavior = behavior;
      if (a.hasState && nonEmpty(a.state.onValue)) {
        out.state = {
          command: out.commands.state,
          onValue: a.state.onValue,
        };
        if (nonEmpty(a.state.matchMode)) out.state.matchMode = a.state.matchMode;
        const pi = asInt(a.state.pollIntervalMs);
        if (pi !== undefined) out.state.pollIntervalMs = pi;
      }
    } else if (a.type === 'garageDoor') {
      const open = commandFrom(a.commands.open);
      const close = commandFrom(a.commands.close);
      if (open) out.commands.open = open;
      if (close) out.commands.close = close;
      if (a.hasState) {
        const state = commandFrom(a.commands.state);
        if (state) out.commands.state = state;
      }
      if (a.hasState) {
        const sm = {};
        const o = matchRuleFrom(a.stateMapping.open);
        const c = matchRuleFrom(a.stateMapping.closed);
        if (o) sm.open = o;
        if (c) sm.closed = c;
        const op = matchRuleFrom(a.stateMapping.opening);
        const cl = matchRuleFrom(a.stateMapping.closing);
        if (op) sm.opening = op;
        if (cl) sm.closing = cl;
        if (sm.open && sm.closed) out.stateMapping = sm;
      }
      const timing = {};
      const ot = asInt(a.timing.openTravelTimeMs);
      const ct = asInt(a.timing.closeTravelTimeMs);
      if (ot !== undefined) timing.openTravelTimeMs = ot;
      if (ct !== undefined) timing.closeTravelTimeMs = ct;
      if (a.hasAutoClose) {
        const at = asInt(a.timing.autoCloseTimeoutMs);
        if (at !== undefined) timing.autoCloseTimeoutMs = at;
        if (nonEmpty(a.timing.autoCloseMode)) timing.autoCloseMode = a.timing.autoCloseMode;
      }
      if (a.hasState) {
        const sp = asInt(a.timing.statePollIntervalMs);
        if (sp !== undefined) timing.statePollIntervalMs = sp;
        const tp = asInt(a.timing.transientPollIntervalMs);
        if (tp !== undefined) timing.transientPollIntervalMs = tp;
        const pcd = asInt(a.timing.postCommandPollDelayMs);
        if (pcd !== undefined) timing.postCommandPollDelayMs = pcd;
      }
      if (Object.keys(timing).length > 0) out.timing = timing;
    }

    return out;
  }

  function toEmittable(m) {
    return {
      platform: PLATFORM,
      name: nonEmpty(m.name) ? m.name : DEFAULT_NAME,
      logLevel: m.logLevel,
      hosts: m.hosts.map(emitHost),
      accessories: m.accessories.map(emitAccessory),
    };
  }

  // ----- Loaders -----
  function loadHost(b) {
    const ssh = b.ssh || {};
    const auth = ssh.auth || { method: 'key' };
    return {
      _key: uid(),
      _connectionStatus: 'unknown',
      id: b.id || '',
      host: ssh.host || '',
      port: ssh.port ?? '',
      user: ssh.user || '',
      auth: {
        method: auth.method || 'key',
        privateKeyPath: auth.privateKeyPath || '',
        passphrase: auth.passphrase || '',
        password: auth.password || '',
      },
      connectTimeoutMs: ssh.connectTimeoutMs ?? '',
      keepaliveIntervalMs: ssh.keepaliveIntervalMs ?? '',
      idleDisconnectMs: ssh.idleDisconnectMs ?? '',
    };
  }

  function loadAccessory(b) {
    const a = {
      _key: uid(),
      type: b.type || 'switch',
      name: b.name || '',
      host: b.host || '',
      commands: {
        on: { command: '', timeoutMs: '' },
        off: { command: '', timeoutMs: '' },
        open: { command: '', timeoutMs: '' },
        close: { command: '', timeoutMs: '' },
        state: { command: '', timeoutMs: '' },
      },
      hasOff: false,
      hasState: false,
      hasAutoClose: false,
      behavior: { mode: 'stateful', autoResetMs: '' },
      state: { onValue: '', matchMode: 'exact', pollIntervalMs: '' },
      stateMapping: {
        open: { match: '', mode: 'exact' },
        closed: { match: '', mode: 'exact' },
        opening: { match: '', mode: 'exact' },
        closing: { match: '', mode: 'exact' },
      },
      timing: {
        openTravelTimeMs: '',
        closeTravelTimeMs: '',
        autoCloseTimeoutMs: '',
        autoCloseMode: 'execute',
        statePollIntervalMs: '',
        transientPollIntervalMs: '',
        postCommandPollDelayMs: '',
      },
    };
    const cmds = b.commands || {};
    if (cmds.on) a.commands.on = { command: cmds.on.command || '', timeoutMs: cmds.on.timeoutMs ?? '' };
    if (cmds.off) {
      a.commands.off = { command: cmds.off.command || '', timeoutMs: cmds.off.timeoutMs ?? '' };
      a.hasOff = true;
    }
    if (cmds.open) a.commands.open = { command: cmds.open.command || '', timeoutMs: cmds.open.timeoutMs ?? '' };
    if (cmds.close) a.commands.close = { command: cmds.close.command || '', timeoutMs: cmds.close.timeoutMs ?? '' };
    if (cmds.state) {
      a.commands.state = { command: cmds.state.command || '', timeoutMs: cmds.state.timeoutMs ?? '' };
      a.hasState = true;
    }
    if (b.behavior) {
      a.behavior.mode = b.behavior.mode || 'stateful';
      a.behavior.autoResetMs = b.behavior.autoResetMs ?? '';
    }
    if (b.state) {
      a.state.onValue = b.state.onValue || '';
      a.state.matchMode = b.state.matchMode || 'exact';
      a.state.pollIntervalMs = b.state.pollIntervalMs ?? '';
      a.hasState = a.hasState || nonEmpty(a.state.onValue);
    }
    if (b.stateMapping) {
      for (const key of ['open', 'closed', 'opening', 'closing']) {
        const r = b.stateMapping[key];
        if (r) a.stateMapping[key] = { match: r.match || '', mode: r.mode || 'exact' };
      }
    }
    if (b.timing) {
      a.timing.openTravelTimeMs = b.timing.openTravelTimeMs ?? '';
      a.timing.closeTravelTimeMs = b.timing.closeTravelTimeMs ?? '';
      a.timing.autoCloseTimeoutMs = b.timing.autoCloseTimeoutMs ?? '';
      a.timing.autoCloseMode = b.timing.autoCloseMode || 'execute';
      a.timing.statePollIntervalMs = b.timing.statePollIntervalMs ?? '';
      a.timing.transientPollIntervalMs = b.timing.transientPollIntervalMs ?? '';
      a.timing.postCommandPollDelayMs = b.timing.postCommandPollDelayMs ?? '';
      if (b.timing.autoCloseTimeoutMs && b.timing.autoCloseTimeoutMs > 0) a.hasAutoClose = true;
    }
    return a;
  }

  function loadConfig(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) return newModel();
    const b = blocks[0];
    return {
      name: b.name || DEFAULT_NAME,
      logLevel: b.logLevel || DEFAULT_LOG_LEVEL,
      hosts: Array.isArray(b.hosts) ? b.hosts.map(loadHost) : [],
      accessories: Array.isArray(b.accessories) ? b.accessories.map(loadAccessory) : [],
    };
  }

  // ----- Renderers -----
  function renderHosts() {
    const list = $('#hosts-list');
    clearChildren(list);
    for (const h of model.hosts) list.appendChild(buildHostCard(h));
    refreshHostDropdowns();
  }

  function buildHostCard(h) {
    const card = instantiate('host-tmpl');
    card.dataset.key = h._key;
    const body = $('.card-body', card);
    const header = $('.card-header', card);
    header.addEventListener('click', () => body.classList.toggle('show'));

    const summary = $('.host-summary', card);
    const dot = $('.status-dot', card);
    const refreshSummary = () => {
      const userHost = `${h.user || '?'}@${h.host || '?'}${h.port ? ':' + h.port : ''}`;
      summary.textContent = h.id ? `${h.id} — ${userHost}` : `(unnamed) — ${userHost}`;
      dot.dataset.status = h._connectionStatus;
    };
    refreshSummary();

    const bind = (selector, prop) => {
      const el = $(selector, card);
      el.value = h[prop] ?? '';
      el.addEventListener('input', () => {
        h[prop] = el.value;
        refreshSummary();
        scheduleSync();
        refreshHostDropdowns();
      });
    };
    bind('.field-id', 'id');
    bind('.field-host', 'host');
    bind('.field-port', 'port');
    bind('.field-user', 'user');
    bind('.field-connect-timeout', 'connectTimeoutMs');
    bind('.field-keepalive', 'keepaliveIntervalMs');
    bind('.field-idle-disconnect', 'idleDisconnectMs');

    const authMethod = $('.field-auth-method', card);
    authMethod.value = h.auth.method;
    const authKeyBlock = $('.auth-key', card);
    const authPasswordBlock = $('.auth-password', card);
    const reflectAuth = () => {
      toggleHidden(authKeyBlock, h.auth.method !== 'key');
      toggleHidden(authPasswordBlock, h.auth.method !== 'password');
    };
    authMethod.addEventListener('change', () => {
      h.auth.method = authMethod.value;
      reflectAuth();
      scheduleSync();
    });

    const bindAuth = (selector, prop) => {
      const el = $(selector, card);
      el.value = h.auth[prop] ?? '';
      el.addEventListener('input', () => {
        h.auth[prop] = el.value;
        scheduleSync();
      });
    };
    bindAuth('.field-private-key', 'privateKeyPath');
    bindAuth('.field-passphrase', 'passphrase');
    bindAuth('.field-password', 'password');
    reflectAuth();

    $('.action-test-connection', card).addEventListener('click', () => testConnection(h, dot));
    $('.action-delete-host', card).addEventListener('click', () => {
      model.hosts = model.hosts.filter((x) => x._key !== h._key);
      renderHosts();
      scheduleSync();
    });

    return card;
  }

  function refreshHostDropdowns() {
    const ids = model.hosts.map((h) => h.id).filter(nonEmpty);
    for (const accCard of $$('.accessory-card')) {
      const select = $('.field-host', accCard);
      const a = model.accessories.find((x) => x._key === accCard.dataset.key);
      if (!a) continue;
      const current = select.value || a.host;
      clearChildren(select);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.textContent = ids.length ? '— pick a host —' : '(no hosts defined)';
      select.appendChild(placeholder);
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      }
      select.value = ids.includes(current) ? current : '';
      a.host = select.value;
    }
  }

  function renderAccessories() {
    const list = $('#accessories-list');
    clearChildren(list);
    for (const a of model.accessories) list.appendChild(buildAccessoryCard(a));
    refreshHostDropdowns();
  }

  function buildAccessoryCard(a) {
    const card = instantiate('accessory-tmpl');
    card.dataset.key = a._key;
    const body = $('.card-body', card);
    const header = $('.card-header', card);
    header.addEventListener('click', () => body.classList.toggle('show'));

    const typeBadge = $('.type-badge', card);
    const summary = $('.accessory-summary', card);
    const hostBadge = $('.host-badge', card);
    const refreshSummary = () => {
      typeBadge.textContent = a.type === 'garageDoor' ? 'Garage' : 'Switch';
      typeBadge.classList.remove('switch', 'garageDoor');
      typeBadge.classList.add(a.type);
      summary.textContent = a.name || '(unnamed)';
      hostBadge.textContent = a.host || '— no host —';
    };
    refreshSummary();

    const switchSections = $$('.commands-switch, .behavior-block, .state-poll-switch', card);
    const garageSections = $$('.commands-garage, .timing-block, .state-map-block', card);
    const reflectType = () => {
      const isGarage = a.type === 'garageDoor';
      switchSections.forEach((el) => toggleHidden(el, isGarage));
      garageSections.forEach((el) => toggleHidden(el, !isGarage));
      reflectStateCmd();
    };

    const nameField = $('.field-name', card);
    nameField.value = a.name;
    nameField.addEventListener('input', () => {
      a.name = nameField.value;
      refreshSummary();
      scheduleSync();
    });

    const hostSelect = $('.field-host', card);
    hostSelect.addEventListener('change', () => {
      a.host = hostSelect.value;
      refreshSummary();
      scheduleSync();
    });

    const bindCmd = (selector, group) => {
      const el = $(selector, card);
      el.value = a.commands[group].command;
      el.addEventListener('input', () => {
        a.commands[group].command = el.value;
        scheduleSync();
      });
    };
    const bindCmdTimeout = (selector, group) => {
      const el = $(selector, card);
      el.value = a.commands[group].timeoutMs ?? '';
      el.addEventListener('input', () => {
        a.commands[group].timeoutMs = el.value;
        scheduleSync();
      });
    };
    bindCmd('.field-cmd-on', 'on');
    bindCmdTimeout('.field-cmd-on-timeout', 'on');
    bindCmd('.field-cmd-off', 'off');
    bindCmdTimeout('.field-cmd-off-timeout', 'off');
    bindCmd('.field-cmd-open', 'open');
    bindCmdTimeout('.field-cmd-open-timeout', 'open');
    bindCmd('.field-cmd-close', 'close');
    bindCmdTimeout('.field-cmd-close-timeout', 'close');
    bindCmd('.field-cmd-state', 'state');
    bindCmdTimeout('.field-cmd-state-timeout', 'state');

    const offToggle = $('.toggle-off', card);
    const offBlock = $('.off-block', card);
    offToggle.checked = a.hasOff;
    toggleHidden(offBlock, !a.hasOff);
    offToggle.addEventListener('change', () => {
      a.hasOff = offToggle.checked;
      toggleHidden(offBlock, !a.hasOff);
      scheduleSync();
    });

    const stateToggle = $('.toggle-state', card);
    const stateCmdBlock = $('.state-cmd-block', card);
    const stateDependentSections = $$('.state-cmd-dependent', card);
    function reflectStateCmd() {
      toggleHidden(stateCmdBlock, !a.hasState);
      stateDependentSections.forEach((el) => {
        const isGarage = a.type === 'garageDoor';
        const isStateMap = el.classList.contains('state-map-block');
        const isStatePollSwitch = el.classList.contains('state-poll-switch');
        const typeOk = isStateMap ? isGarage : isStatePollSwitch ? !isGarage : true;
        toggleHidden(el, !a.hasState || !typeOk);
      });
    }
    stateToggle.checked = a.hasState;
    stateToggle.addEventListener('change', () => {
      a.hasState = stateToggle.checked;
      reflectStateCmd();
      scheduleSync();
    });

    const behaviorMode = $('.field-behavior-mode', card);
    behaviorMode.value = a.behavior.mode;
    const momentaryBlock = $('.momentary-block', card);
    const reflectBehavior = () => toggleHidden(momentaryBlock, a.behavior.mode !== 'momentary');
    reflectBehavior();
    behaviorMode.addEventListener('change', () => {
      a.behavior.mode = behaviorMode.value;
      reflectBehavior();
      scheduleSync();
    });
    const autoReset = $('.field-auto-reset', card);
    autoReset.value = a.behavior.autoResetMs ?? '';
    autoReset.addEventListener('input', () => {
      a.behavior.autoResetMs = autoReset.value;
      scheduleSync();
    });

    const bindStateField = (selector, prop) => {
      const el = $(selector, card);
      el.value = a.state[prop] ?? '';
      el.addEventListener('input', () => {
        a.state[prop] = el.value;
        scheduleSync();
      });
    };
    bindStateField('.field-on-value', 'onValue');
    bindStateField('.field-match-mode', 'matchMode');
    bindStateField('.field-poll-interval', 'pollIntervalMs');

    const bindMap = (selector, group, prop) => {
      const el = $(selector, card);
      el.value = a.stateMapping[group][prop] ?? '';
      el.addEventListener('input', () => {
        a.stateMapping[group][prop] = el.value;
        scheduleSync();
      });
    };
    bindMap('.field-map-open-match', 'open', 'match');
    bindMap('.field-map-open-mode', 'open', 'mode');
    bindMap('.field-map-closed-match', 'closed', 'match');
    bindMap('.field-map-closed-mode', 'closed', 'mode');
    bindMap('.field-map-opening-match', 'opening', 'match');
    bindMap('.field-map-opening-mode', 'opening', 'mode');
    bindMap('.field-map-closing-match', 'closing', 'match');
    bindMap('.field-map-closing-mode', 'closing', 'mode');

    const bindTiming = (selector, prop) => {
      const el = $(selector, card);
      el.value = a.timing[prop] ?? '';
      el.addEventListener('input', () => {
        a.timing[prop] = el.value;
        scheduleSync();
      });
    };
    bindTiming('.field-open-travel', 'openTravelTimeMs');
    bindTiming('.field-close-travel', 'closeTravelTimeMs');
    bindTiming('.field-autoclose-timeout', 'autoCloseTimeoutMs');
    bindTiming('.field-state-poll-interval', 'statePollIntervalMs');
    bindTiming('.field-transient-poll-interval', 'transientPollIntervalMs');
    bindTiming('.field-post-command-poll-delay', 'postCommandPollDelayMs');
    const autoCloseModeSelect = $('.field-autoclose-mode', card);
    autoCloseModeSelect.value = a.timing.autoCloseMode;
    autoCloseModeSelect.addEventListener('change', () => {
      a.timing.autoCloseMode = autoCloseModeSelect.value;
      scheduleSync();
    });

    const autoCloseToggle = $('.toggle-autoclose', card);
    const autoCloseBlock = $('.autoclose-block', card);
    autoCloseToggle.checked = a.hasAutoClose;
    toggleHidden(autoCloseBlock, !a.hasAutoClose);
    autoCloseToggle.addEventListener('change', () => {
      a.hasAutoClose = autoCloseToggle.checked;
      toggleHidden(autoCloseBlock, !a.hasAutoClose);
      scheduleSync();
    });

    $('.action-test-on', card).addEventListener('click', () => testCommandFor(a, 'on'));
    $('.action-test-off', card).addEventListener('click', () => testCommandFor(a, 'off'));
    $('.action-test-open', card).addEventListener('click', () => testCommandFor(a, 'open'));
    $('.action-test-close', card).addEventListener('click', () => testCommandFor(a, 'close'));
    $('.action-test-state', card).addEventListener('click', () => testCommandFor(a, 'state'));

    $('.action-delete-accessory', card).addEventListener('click', () => {
      model.accessories = model.accessories.filter((x) => x._key !== a._key);
      renderAccessories();
      scheduleSync();
    });

    reflectType();

    return card;
  }

  // ----- Test buttons -----
  async function testConnection(host, dot) {
    homebridge.showSpinner();
    try {
      const result = await homebridge.request('/test-connection', { host: emitHost(host) });
      host._connectionStatus = 'ok';
      dot.dataset.status = 'ok';
      dot.title = `connected in ${result.latencyMs}ms`;
      homebridge.toast.success(`Connected (${result.latencyMs}ms)`);
    } catch (err) {
      host._connectionStatus = 'fail';
      dot.dataset.status = 'fail';
      dot.title = err.message;
      homebridge.toast.error(err.message || 'connection failed');
    } finally {
      homebridge.hideSpinner();
    }
  }

  async function testCommandFor(accessory, group) {
    const host = model.hosts.find((h) => h.id === accessory.host);
    if (!host) {
      homebridge.toast.warning('Pick a host first.');
      return;
    }
    const cmd = accessory.commands[group];
    if (!cmd || !nonEmpty(cmd.command)) {
      homebridge.toast.warning('Enter the command first.');
      return;
    }
    homebridge.showSpinner();
    try {
      const result = await homebridge.request('/test-command', {
        host: emitHost(host),
        command: { command: cmd.command, timeoutMs: asInt(cmd.timeoutMs) || 5000 },
      });
      const summary = `exit ${result.exitCode} in ${result.durationMs}ms`;
      const body =
        result.exitCode === 0 ? result.stdout || '(no stdout)' : result.stderr || result.stdout || '(no output)';
      // Call directly on `homebridge.toast` so the method retains its `this`
      // binding — extracting it into a variable strips the binding and the
      // toast helper fails at `this._postMessage`.
      if (result.exitCode === 0) {
        homebridge.toast.success(`${summary}\n${body}`, group);
      } else {
        homebridge.toast.warning(`${summary}\n${body}`, group);
      }
    } catch (err) {
      homebridge.toast.error(err.message || 'command failed', group);
    } finally {
      homebridge.hideSpinner();
    }
  }

  // ----- Top-level controls -----
  function wireToplevel() {
    const bridgeName = $('#bridge-name');
    bridgeName.value = model.name;
    bridgeName.addEventListener('input', () => {
      model.name = bridgeName.value;
      scheduleSync();
    });
    const logLevel = $('#log-level');
    logLevel.value = model.logLevel;
    logLevel.addEventListener('change', () => {
      model.logLevel = logLevel.value;
      scheduleSync();
    });

    $('#add-host').addEventListener('click', () => {
      model.hosts.push({
        _key: uid(),
        _connectionStatus: 'unknown',
        id: '',
        host: '',
        port: '',
        user: '',
        auth: { method: 'key', privateKeyPath: '', passphrase: '', password: '' },
        connectTimeoutMs: '',
        keepaliveIntervalMs: '',
        idleDisconnectMs: '',
      });
      renderHosts();
      scheduleSync();
    });

    const addAccessory = (type) => () => {
      const a = loadAccessory({ type, name: '', host: model.hosts[0]?.id || '', commands: {} });
      model.accessories.push(a);
      renderAccessories();
      scheduleSync();
    };
    $('#add-switch').addEventListener('click', addAccessory('switch'));
    $('#add-garage').addEventListener('click', addAccessory('garageDoor'));

    $('#save').addEventListener('click', async () => {
      homebridge.showSpinner();
      try {
        await homebridge.updatePluginConfig([toEmittable(model)]);
        await homebridge.savePluginConfig();
        homebridge.toast.success('Saved');
      } catch (err) {
        homebridge.toast.error(err.message || 'save failed');
      } finally {
        homebridge.hideSpinner();
      }
    });

    $('#show-json').addEventListener('click', () => {
      try {
        homebridge.showSchemaForm();
      } catch (err) {
        homebridge.toast.error(err.message || 'cannot show schema form');
      }
    });
  }

  // ----- Boot -----
  homebridge.addEventListener('ready', async () => {
    try {
      const blocks = await homebridge.getPluginConfig();
      model = loadConfig(blocks);
    } catch (err) {
      console.error('failed to load config', err);
      model = newModel();
    }
    wireToplevel();
    renderHosts();
    renderAccessories();
  });
})();

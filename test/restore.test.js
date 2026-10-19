import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn, execSync } from 'node:child_process';

import {
  isOfficialPackage,
  isSafeSnapshotFolder,
  validateSnapshot,
  resolveDshVersion,
  computeRestorePlan,
  RestoreEngine,
} from '../lib/restore-engine.js';
import { apply } from '../lib/index.js';

describe('dsh-plugin-version-management sandbox restore test suite', () => {
  const tmpRoot = path.join(os.tmpdir(), `dsh-pvm-test-${Date.now()}`);
  const sandboxProfileDir = path.join(tmpRoot, 'profile');
  const sandboxSnapshotDir = path.join(tmpRoot, 'snapshots');
  const sandboxHomeDir = path.join(tmpRoot, 'home');

  before(async () => {
    await mkdir(sandboxProfileDir, { recursive: true });
    await mkdir(sandboxSnapshotDir, { recursive: true });
    await mkdir(sandboxHomeDir, { recursive: true });

    // Create fake runtime package.json in home/runtime
    const runtimeDir = path.join(sandboxHomeDir, 'runtime');
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      path.join(runtimeDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-runtime', version: '0.2.2-test.1' }, null, 2),
      'utf8'
    );

    // Create initial profile package.json
    const initialPkg = {
      name: 'dsh-profile-sandbox',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh': '0.2.2-test.1',
        '@deepseek-ai/cordis': '4.0.5',
        'foo-plugin': '^1.0.0',
        'bar-plugin': 'file:../local-bar',
        'extra-to-be-removed': '^0.5.0',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh',
            '@deepseek-ai/cordis',
            'foo-plugin',
            'bar-plugin',
            'extra-to-be-removed',
          ],
        },
      },
    };
    await writeFile(path.join(sandboxProfileDir, 'package.json'), JSON.stringify(initialPkg, null, 2), 'utf8');
    await writeFile(path.join(sandboxProfileDir, 'pnpm-lock.yaml'), 'lockfile-v6-dummy-content: true\n', 'utf8');

    // Create fake node_modules for installed version resolution
    const fooModDir = path.join(sandboxProfileDir, 'node_modules', 'foo-plugin');
    await mkdir(fooModDir, { recursive: true });
    await writeFile(path.join(fooModDir, 'package.json'), JSON.stringify({ name: 'foo-plugin', version: '1.0.8' }), 'utf8');

    const extraModDir = path.join(sandboxProfileDir, 'node_modules', 'extra-to-be-removed');
    await mkdir(extraModDir, { recursive: true });
    await writeFile(path.join(extraModDir, 'package.json'), JSON.stringify({ name: 'extra-to-be-removed', version: '0.5.2' }), 'utf8');
  });

  after(async () => {
    try {
      await rm(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  test('1. Security & path validation: isSafeSnapshotFolder', () => {
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, 'snapshot-2026-10-19'), true);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, '../escaped'), false);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, 'sub/folder'), false);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, 'sub\\folder'), false);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, 'C:\\Windows'), false);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, ''), false);
    assert.equal(isSafeSnapshotFolder(sandboxSnapshotDir, null), false);
  });

  test('2. Dynamic version resolution: extracts version and returns unknown on fallback', () => {
    const version = resolveDshVersion(sandboxHomeDir, sandboxProfileDir);
    assert.equal(version, '0.2.2-test.1');

    const emptyDir = path.join(tmpRoot, 'empty-dir');
    const unknownVersion = resolveDshVersion(emptyDir, emptyDir);
    assert.equal(unknownVersion, 'unknown');
  });

  test('3. readProfilePkg throws on missing or malformed package.json to prevent config corruption', async () => {
    const badEngine = new RestoreEngine({
      profileDir: path.join(tmpRoot, 'non-existent-profile'),
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
    });
    assert.throws(() => badEngine.readProfilePkg(), /missing at/);

    const corruptDir = path.join(tmpRoot, 'corrupt-profile');
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, 'package.json'), '{ broken json', 'utf8');
    const corruptEngine = new RestoreEngine({
      profileDir: corruptDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
    });
    assert.throws(() => corruptEngine.readProfilePkg(), /Cannot parse profile package\.json/);
  });

  test('4. Snapshot creation pins registry package, preserves file/git, and generates ms+rand unique folder', async () => {
    const engine = new RestoreEngine({
      profileDir: sandboxProfileDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
    });

    const res1 = await engine.createSnapshot();
    const res2 = await engine.createSnapshot();

    // Verify folder name format: snapshot-YYYY-MM-DD-HH-mm-ss-mmm-rand
    assert.match(res1.folderName, /^snapshot-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}-[a-z0-9]+$/);
    assert.notEqual(res1.folderName, res2.folderName, 'Rapid consecutive snapshots must have unique folder names');
    assert.equal(existsSync(res1.folderPath), true);
    assert.equal(res1.pluginCount, 5);

    const snap = res1.snapshot;
    assert.equal(snap.format, 'dsh-plugin-snapshot');
    // foo-plugin required ^1.0.0, but node_modules had 1.0.8 -> pinned to 1.0.8!
    assert.equal(snap.dependencies['foo-plugin'], '1.0.8');
    // bar-plugin was file:../local-bar -> preserved!
    assert.equal(snap.dependencies['bar-plugin'], 'file:../local-bar');
    // Official packages preserved
    assert.equal(snap.dependencies['@deepseek-ai/dsh'], '0.2.2-test.1');
  });

  test('5. computeRestorePlan: full restore removes third-party additions, restores snapshot version, and updates bundles', () => {
    const curPkg = {
      dependencies: {
        '@deepseek-ai/dsh': '0.2.2',
        'foo-plugin': '2.0.0', // modified
        'unwanted-plugin': '3.0.0', // added in current profile, not in snapshot
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh', 'foo-plugin', 'unwanted-plugin'],
        },
      },
    };

    const snap = {
      format: 'dsh-plugin-snapshot',
      dependencies: {
        '@deepseek-ai/dsh': '0.1.0', // official in snapshot should NOT downgrade current official
        'foo-plugin': '1.0.8',
        'restored-plugin': '0.9.0',
      },
      bundles: ['@deepseek-ai/dsh', 'foo-plugin', 'restored-plugin'],
    };

    // Full restore (names is empty array [])
    const plan = computeRestorePlan(curPkg, snap, []);
    assert.equal(plan.isFull, true);
    assert.equal(plan.isNoop, false);

    const changes = plan.changes;
    const actions = Object.fromEntries(changes.map(c => [c.name, c.action]));
    assert.equal(actions['foo-plugin'], 'modify');
    assert.equal(actions['restored-plugin'], 'add');
    assert.equal(actions['unwanted-plugin'], 'remove');
    assert.equal(actions['@deepseek-ai/dsh'], undefined); // official protected

    // Target deps
    assert.equal(plan.targetDeps['@deepseek-ai/dsh'], '0.2.2'); // current official kept
    assert.equal(plan.targetDeps['foo-plugin'], '1.0.8');
    assert.equal(plan.targetDeps['restored-plugin'], '0.9.0');
    assert.equal(plan.targetDeps['unwanted-plugin'], undefined);

    // Target bundles
    assert.deepEqual(plan.targetBundles, ['@deepseek-ai/dsh', 'foo-plugin', 'restored-plugin']);
  });

  test('6. computeRestorePlan: subset restore only touches specified plugins', () => {
    const curPkg = {
      dependencies: {
        '@deepseek-ai/dsh': '0.2.2',
        'foo-plugin': '2.0.0',
        'keep-this-other': '4.0.0',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh', 'foo-plugin', 'keep-this-other'],
        },
      },
    };

    const snap = {
      format: 'dsh-plugin-snapshot',
      dependencies: {
        'foo-plugin': '1.0.8',
        'other-snap-plugin': '5.0.0',
      },
      bundles: ['foo-plugin', 'other-snap-plugin'],
    };

    // Subset restore only foo-plugin
    const plan = computeRestorePlan(curPkg, snap, ['foo-plugin']);
    assert.equal(plan.isFull, false);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].name, 'foo-plugin');
    assert.equal(plan.changes[0].action, 'modify');

    // keep-this-other is NOT removed because it's a subset restore
    assert.equal(plan.targetDeps['keep-this-other'], '4.0.0');
    assert.equal(plan.targetDeps['foo-plugin'], '1.0.8');
    assert.equal(plan.targetDeps['other-snap-plugin'], undefined);
  });

  test('7. computeRestorePlan: no-op detection', () => {
    const curPkg = {
      dependencies: {
        '@deepseek-ai/dsh': '0.2.2',
        'foo-plugin': '1.0.8',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh', 'foo-plugin'] } },
    };
    const snap = {
      format: 'dsh-plugin-snapshot',
      dependencies: { 'foo-plugin': '1.0.8' },
      bundles: ['foo-plugin'],
    };
    const plan = computeRestorePlan(curPkg, snap, []);
    assert.equal(plan.isNoop, true);
    assert.equal(plan.changes.length, 0);
  });

  test('8. Restore execution with simulated pnpm success: updates manifest & creates backups', async () => {
    const mockSpawnSuccess = () => {
      const emitter = new EventEmitter();
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        emitter.stdout.emit('data', Buffer.from('Packages: +1\nProgress: resolved 1, reused 1\n'));
        emitter.emit('close', 0);
      }, 50);
      return emitter;
    };

    const engine = new RestoreEngine({
      profileDir: sandboxProfileDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
      spawnPnpm: mockSpawnSuccess,
    });

    const targetSnap = {
      format: 'dsh-plugin-snapshot',
      dependencies: {
        'foo-plugin': '1.0.8',
        'new-plugin': '2.0.0',
      },
      bundles: ['foo-plugin', 'new-plugin'],
    };

    const res = await engine.applyRestore({ snap: targetSnap, names: [] });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'started');
    assert.equal(existsSync(res.backupPath), true);
    assert.equal(existsSync(res.lockBackupPath), true);

    const status = await res.promise;
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 0);
    assert.equal(status.error, null);
    assert.match(status.logTail, /Success/);

    // Verify package.json was written with new plugins
    const updatedPkg = JSON.parse(readFileSync(path.join(sandboxProfileDir, 'package.json'), 'utf8'));
    assert.equal(updatedPkg.dependencies['new-plugin'], '2.0.0');
    // extra-to-be-removed was deleted in full restore!
    assert.equal(updatedPkg.dependencies['extra-to-be-removed'], undefined);
  });

  test('9. Restore execution with simulated pnpm failure: rolls back package.json and pnpm-lock.yaml and reports uncertain state', async () => {
    const pkgBefore = readFileSync(path.join(sandboxProfileDir, 'package.json'), 'utf8');
    const lockBefore = readFileSync(path.join(sandboxProfileDir, 'pnpm-lock.yaml'), 'utf8');

    const mockSpawnFailure = () => {
      const emitter = new EventEmitter();
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        emitter.stderr.emit('data', Buffer.from('ERR_PNPM_FETCH_404: Package not found\n'));
        emitter.emit('close', 1);
      }, 50);
      return emitter;
    };

    const engine = new RestoreEngine({
      profileDir: sandboxProfileDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
      spawnPnpm: mockSpawnFailure,
    });

    const brokenSnap = {
      format: 'dsh-plugin-snapshot',
      dependencies: {
        'non-existent-plugin-xyz': '9.9.9',
      },
      bundles: ['non-existent-plugin-xyz'],
    };

    const res = await engine.applyRestore({ snap: brokenSnap, names: [] });
    assert.equal(res.ok, true);

    const status = await res.promise;
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 1);
    assert.match(status.error, /rolled back/i);
    assert.match(status.error, /uncertain/i);

    // Verify package.json and pnpm-lock.yaml were rolled back!
    const pkgAfter = readFileSync(path.join(sandboxProfileDir, 'package.json'), 'utf8');
    const lockAfter = readFileSync(path.join(sandboxProfileDir, 'pnpm-lock.yaml'), 'utf8');
    assert.equal(pkgAfter, pkgBefore);
    assert.equal(lockAfter, lockBefore);
  });

  test('10. Lockfile rollback cleanup when originally no lockfile existed', async () => {
    const noLockProfileDir = path.join(tmpRoot, 'no-lock-profile');
    await mkdir(noLockProfileDir, { recursive: true });
    const initialPkg = {
      dependencies: { 'foo-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['foo-plugin'] } },
    };
    await writeFile(path.join(noLockProfileDir, 'package.json'), JSON.stringify(initialPkg, null, 2), 'utf8');
    assert.equal(existsSync(path.join(noLockProfileDir, 'pnpm-lock.yaml')), false);

    // Simulate pnpm creating a temporary lockfile during failed install
    const mockSpawnFailCreateLock = () => {
      const emitter = new EventEmitter();
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        // write fake lockfile during run
        writeFile(path.join(noLockProfileDir, 'pnpm-lock.yaml'), 'created-by-failed-run: true\n', 'utf8').then(() => {
          emitter.stderr.emit('data', Buffer.from('Installation aborted\n'));
          emitter.emit('close', 1);
        });
      }, 50);
      return emitter;
    };

    const engine = new RestoreEngine({
      profileDir: noLockProfileDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
      spawnPnpm: mockSpawnFailCreateLock,
    });

    const snap = {
      format: 'dsh-plugin-snapshot',
      dependencies: { 'foo-plugin': '2.0.0' },
      bundles: ['foo-plugin'],
    };

    const res = await engine.applyRestore({ snap, names: [] });
    await res.promise;

    // After failure rollback, pnpm-lock.yaml should NOT exist because it did not exist originally!
    assert.equal(existsSync(path.join(noLockProfileDir, 'pnpm-lock.yaml')), false);
  });

  test('11. Spawn double-event deduplication (error + close triggers rollback once)', async () => {
    let rollbackCount = 0;
    const testDir = path.join(tmpRoot, 'dedup-profile');
    await mkdir(testDir, { recursive: true });
    await writeFile(path.join(testDir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8');

    const mockSpawnDoubleTrigger = () => {
      const emitter = new EventEmitter();
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        emitter.emit('error', new Error('Spawn error simulated'));
        emitter.emit('close', 1);
      }, 30);
      return emitter;
    };

    const engine = new RestoreEngine({
      profileDir: testDir,
      snapshotDir: sandboxSnapshotDir,
      dshHome: sandboxHomeDir,
      spawnPnpm: mockSpawnDoubleTrigger,
    });

    const res = await engine.applyRestore({
      snap: { format: 'dsh-plugin-snapshot', dependencies: { 'pkg-a': '1.0.0' } },
      names: [],
    });

    const status = await res.promise;
    assert.equal(status.running, false);
    assert.equal(status.exitCode, 1);
    assert.match(status.error, /failed to start/);
  });

  test('12. HTTP route integration via plugin apply', async () => {
    let routeHandler = null;
    const mockWebServer = {
      register(route) {
        if (route.path === '/dsh-pvm') {
          routeHandler = route.handler;
        }
      },
    };
    const mockTools = {
      tools: [],
      register(t) { this.tools.push(t); },
    };

    const mockCtx = {
      webServer: mockWebServer,
      tools: mockTools,
    };

    apply(mockCtx, {
      profileDir: sandboxProfileDir,
      snapshotDir: sandboxSnapshotDir,
      homeDir: sandboxHomeDir,
    });

    assert.ok(routeHandler, 'Route handler should be registered');

    // Helper to simulate HTTP requests
    const callRoute = async (pathname, method = 'GET', body = null) => {
      return new Promise((resolve) => {
        const req = new EventEmitter();
        req.url = `/dsh-pvm/${pathname}`;
        req.method = method;
        req[Symbol.asyncIterator] = async function* () {
          if (body) yield Buffer.from(JSON.stringify(body));
        };

        const res = {
          writeHead(status, headers) { this.status = status; this.headers = headers; },
          end(data) {
            this.body = JSON.parse(data);
            resolve({ status: this.status, body: this.body });
          },
        };

        routeHandler(req, res);
      });
    };

    // Test list-plugins
    const listRes = await callRoute('list-plugins');
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.ok, true);
    assert.equal(listRes.body.info.dshVersion, '0.2.2-test.1');

    // Test restore-preview with uploaded content
    const testSnap = {
      format: 'dsh-plugin-snapshot',
      dependencies: { 'uploaded-plugin': '1.0.0' },
      bundles: ['uploaded-plugin'],
    };
    const previewRes = await callRoute('restore-preview', 'POST', {
      source: 'upload',
      content: JSON.stringify(testSnap),
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.body.ok, true);
    assert.equal(previewRes.body.changes.length > 0, true);

    // Test path traversal rejection on read-snapshot
    const badRead = await callRoute('read-snapshot', 'POST', { folder: '../escape' });
    assert.equal(badRead.status, 400);

    // Test restore-status
    const statusRes = await callRoute('restore-status');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.running, false);
  });

  test('13. Host real pnpm executable verification without touching production profile', async () => {
    const isWin = process.platform === 'win32';

    const pnpmVersion = await new Promise((resolve) => {
      try {
        let proc;
        if (isWin) {
          const comspec = process.env.ComSpec || 'cmd.exe';
          proc = spawn(comspec, ['/d', '/s', '/c', 'pnpm --version'], { windowsHide: true });
        } else {
          proc = spawn('pnpm', ['--version'], { windowsHide: true });
        }
        let out = '';
        proc.stdout?.on('data', d => { out += d.toString(); });
        proc.on('close', code => {
          resolve({ ok: code === 0, version: out.trim() });
        });
        proc.on('error', err => {
          resolve({ ok: false, error: err.message });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });

    assert.equal(pnpmVersion.ok, true, `Host pnpm executable should start successfully: ${JSON.stringify(pnpmVersion)}`);
    assert.match(pnpmVersion.version, /^\d+\.\d+\.\d+/);
  });

  test('14. Cordis Context Proxy regression: undeclared service access throws without breaking plugin', async () => {
    let routeHandler = null;
    const rawCtx = {
      webServer: {
        register(route) {
          if (route.path === '/dsh-pvm') {
            routeHandler = route.handler;
          }
        },
      },
      tools: {
        register() {},
      },
    };

    // Strict Cordis Proxy: accessing undeclared services (e.g. app, version, profileContext, logger) throws
    const cordisProxyCtx = new Proxy(rawCtx, {
      get(target, prop) {
        if (typeof prop === 'symbol' || prop === 'constructor' || prop === 'valueOf' || prop === 'toString') {
          return target[prop];
        }
        if (prop in target) {
          return target[prop];
        }
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });

    // Verify proxy behavior throws on undeclared service access
    assert.throws(() => cordisProxyCtx.app, /cannot get property "app" without inject/);
    assert.throws(() => cordisProxyCtx.version, /cannot get property "version" without inject/);
    assert.throws(() => cordisProxyCtx.profileContext, /cannot get property "profileContext" without inject/);

    // Calling apply with cordisProxyCtx should NOT throw
    assert.doesNotThrow(() => {
      apply(cordisProxyCtx, {
        profileDir: sandboxProfileDir,
        snapshotDir: sandboxSnapshotDir,
        homeDir: sandboxHomeDir,
      });
    });

    assert.ok(routeHandler, 'Route handler should be registered');

    // Executing list-plugins through routeHandler should succeed with 200 without accessing undeclared services
    const listRes = await new Promise((resolve) => {
      const req = new EventEmitter();
      req.url = '/dsh-pvm/list-plugins';
      req.method = 'GET';
      req[Symbol.asyncIterator] = async function* () {};

      const res = {
        writeHead(status) { this.status = status; },
        end(data) {
          this.body = JSON.parse(data);
          resolve({ status: this.status, body: this.body });
        },
      };

      routeHandler(req, res);
    });

    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.ok, true);
    assert.equal(listRes.body.info.dshVersion, '0.2.2-test.1');
  });

  test('15. Native model tool registration: dsh-tools contract schema compliance without warnings', async () => {
    let registeredTools = [];
    const mockCtx = {
      webServer: { register() {} },
      tools: {
        register(t) { registeredTools.push(t); },
      },
    };

    apply(mockCtx, {
      profileDir: sandboxProfileDir,
      snapshotDir: sandboxSnapshotDir,
      homeDir: sandboxHomeDir,
      runtimeDir: 'C:/Users/ldc/AppData/Local/dsh-delegation-isolated/v2-desktop-parity/runtime',
    });

    assert.equal(registeredTools.length, 2, 'Should register 2 tools (snapshot and restore)');
    const snapshotTool = registeredTools.find(t => t.name === 'dsh_plugin_snapshot');
    const restoreTool = registeredTools.find(t => t.name === 'dsh_plugin_restore');

    assert.ok(snapshotTool, 'dsh_plugin_snapshot should be registered');
    assert.deepEqual(snapshotTool.parameters, { type: 'object', properties: {} });

    assert.ok(restoreTool, 'dsh_plugin_restore should be registered');
    assert.equal(restoreTool.parameters.type, 'object');
    assert.ok(restoreTool.parameters.properties.folder, 'folder property should exist');
    assert.ok(restoreTool.parameters.properties.names, 'names property should exist');
    assert.ok(restoreTool.parameters.properties.apply, 'apply property should exist');
  });

  test('16. Generated restore scripts (RESTORE_PS1 & RESTORE_MERGE_JS): exit code propagation & corepack fallback', async () => {
    const scriptSandbox = path.join(tmpRoot, 'script-sandbox');
    const profDir = path.join(scriptSandbox, 'profile');
    const snapDir = path.join(scriptSandbox, 'snapshots');
    await mkdir(profDir, { recursive: true });
    await mkdir(snapDir, { recursive: true });

    await writeFile(path.join(profDir, 'package.json'), JSON.stringify({ name: 'prof', dependencies: {} }, null, 2), 'utf8');

    let routeHandler = null;
    const ctx = {
      webServer: { register(r) { if (r.path === '/dsh-pvm') routeHandler = r.handler; } },
      tools: { register() {} },
    };
    apply(ctx, { profileDir: profDir, snapshotDir: snapDir, homeDir: scriptSandbox });

    const snapRes = await new Promise((resolve) => {
      const req = { url: '/dsh-pvm/create-snapshot', method: 'POST', [Symbol.asyncIterator]: async function* () {} };
      const res = { writeHead() {}, end(d) { resolve(JSON.parse(d)); } };
      routeHandler(req, res);
    });

    const ps1Path = path.join(snapRes.folderPath, 'dsh-plugin-restore.ps1');
    const mergeJsPath = path.join(snapRes.folderPath, 'dsh-plugin-restore-merge.js');
    assert.ok(existsSync(ps1Path));
    assert.ok(existsSync(mergeJsPath));

    const ps1Content = await readFile(ps1Path, 'utf8');
    assert.match(ps1Content, /corepack\s+pnpm\s+install/i, 'RESTORE_PS1 should contain corepack fallback');
    assert.match(ps1Content, /\$installExitCode\s*=\s*1/, 'RESTORE_PS1 should set non-zero exit code when pnpm missing');
    assert.match(ps1Content, /exit\s+\$installExitCode/, 'RESTORE_PS1 should propagate non-zero exit code on failure');

    // Test failure exit code propagation
    const snapJsonPath = path.join(snapRes.folderPath, 'dsh-plugin-snapshot.json');
    const snapObj = JSON.parse(await readFile(snapJsonPath, 'utf8'));
    snapObj.dependencies = { 'unresolvable-bogus-package-404': '9.9.9' };
    await writeFile(snapJsonPath, JSON.stringify(snapObj, null, 2), 'utf8');

    let caughtError = null;
    try {
      execSync('powershell -NoProfile -ExecutionPolicy Bypass -File ' + JSON.stringify(ps1Path), { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
    } catch (e) {
      caughtError = e;
    }
    assert.ok(caughtError, 'Script execution should fail on invalid dependency');
    assert.notEqual(caughtError.status, 0, 'Exit code should be non-zero');
    assert.match(caughtError.stdout || '', /\[ERROR\]/i, 'Output should contain error indicator');
    assert.doesNotMatch(caughtError.stdout || '', /Done\.\s+Restart\s+DSH/i, 'Failed run must not output Done message');
  });

  test('17. Real pnpm restore acceptance in independent temporary sandbox (non-mock)', async () => {
    const realRoot = path.join(tmpRoot, 'real-pnpm-sandbox');
    const fixturesDir = path.join(realRoot, 'fixtures');
    const alphaV1Dir = path.join(fixturesDir, 'alpha-v1');
    const alphaV2Dir = path.join(fixturesDir, 'alpha-v2');
    const betaV1Dir = path.join(fixturesDir, 'beta-v1');

    await mkdir(alphaV1Dir, { recursive: true });
    await writeFile(path.join(alphaV1Dir, 'package.json'), JSON.stringify({ name: 'demo-plugin-alpha', version: '1.0.0' }, null, 2), 'utf8');
    await writeFile(path.join(alphaV1Dir, 'index.js'), 'export const version = "1.0.0";\n', 'utf8');

    await mkdir(alphaV2Dir, { recursive: true });
    await writeFile(path.join(alphaV2Dir, 'package.json'), JSON.stringify({ name: 'demo-plugin-alpha', version: '2.0.0' }, null, 2), 'utf8');
    await writeFile(path.join(alphaV2Dir, 'index.js'), 'export const version = "2.0.0";\n', 'utf8');

    await mkdir(betaV1Dir, { recursive: true });
    await writeFile(path.join(betaV1Dir, 'package.json'), JSON.stringify({ name: 'demo-plugin-beta', version: '1.5.0' }, null, 2), 'utf8');
    await writeFile(path.join(betaV1Dir, 'index.js'), 'export const version = "1.5.0";\n', 'utf8');

    const profDir = path.join(realRoot, 'profile');
    const snapDir = path.join(realRoot, 'snapshots');
    await mkdir(profDir, { recursive: true });
    await mkdir(snapDir, { recursive: true });

    // Step A: Initial profile with alpha-v1
    const initialPkg = {
      name: 'real-sandbox-profile',
      private: true,
      dependencies: {
        'demo-plugin-alpha': 'file:../fixtures/alpha-v1',
      },
      dsh: {
        profile: {
          bundles: ['demo-plugin-alpha'],
        },
      },
    };
    await writeFile(path.join(profDir, 'package.json'), JSON.stringify(initialPkg, null, 2), 'utf8');

    // Run real pnpm install
    execSync('pnpm install', { cwd: profDir, stdio: 'ignore', timeout: 30000 });

    // Verify initial installed version
    const initAlphaPkg = JSON.parse(await readFile(path.join(profDir, 'node_modules', 'demo-plugin-alpha', 'package.json'), 'utf8'));
    assert.equal(initAlphaPkg.version, '1.0.0');

    // Step B: Create snapshot of initial state using real RestoreEngine
    const engine = new RestoreEngine({
      profileDir: profDir,
      snapshotDir: snapDir,
      dshHome: realRoot,
    });
    const snapResult = await engine.createSnapshot();
    assert.equal(snapResult.pluginCount, 1);
    assert.equal(snapResult.snapshot.dependencies['demo-plugin-alpha'], 'file:../fixtures/alpha-v1');
    assert.deepEqual(snapResult.snapshot.bundles, ['demo-plugin-alpha']);

    // Step C: Mutate profile - upgrade alpha to v2.0.0 and add beta-v1
    const mutatedPkg = {
      name: 'real-sandbox-profile',
      private: true,
      dependencies: {
        'demo-plugin-alpha': 'file:../fixtures/alpha-v2',
        'demo-plugin-beta': 'file:../fixtures/beta-v1',
      },
      dsh: {
        profile: {
          bundles: ['demo-plugin-alpha', 'demo-plugin-beta'],
        },
      },
    };
    await writeFile(path.join(profDir, 'package.json'), JSON.stringify(mutatedPkg, null, 2), 'utf8');
    execSync('pnpm install', { cwd: profDir, stdio: 'ignore', timeout: 30000 });

    const mutatedAlphaPkg = JSON.parse(await readFile(path.join(profDir, 'node_modules', 'demo-plugin-alpha', 'package.json'), 'utf8'));
    const mutatedBetaPkg = JSON.parse(await readFile(path.join(profDir, 'node_modules', 'demo-plugin-beta', 'package.json'), 'utf8'));
    assert.equal(mutatedAlphaPkg.version, '2.0.0');
    assert.equal(mutatedBetaPkg.version, '1.5.0');

    // Step D: Real restore execution via RestoreEngine (non-mock, host real pnpm)
    const restoreRes = await engine.applyRestore({ snap: snapResult.snapshot, names: [] });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.status, 'started');

    const finalStatus = await restoreRes.promise;
    assert.equal(finalStatus.running, false);
    assert.equal(finalStatus.exitCode, 0);
    assert.equal(finalStatus.error, null);
    assert.match(finalStatus.logTail, /Success/i);

    // Step E: Verify restored state
    const restoredPkg = JSON.parse(await readFile(path.join(profDir, 'package.json'), 'utf8'));
    assert.equal(restoredPkg.dependencies['demo-plugin-alpha'], 'file:../fixtures/alpha-v1');
    assert.equal(restoredPkg.dependencies['demo-plugin-beta'], undefined, 'demo-plugin-beta should be removed from dependencies');
    assert.deepEqual(restoredPkg.dsh.profile.bundles, ['demo-plugin-alpha'], 'bundles should be restored to snapshot state');

    const restoredAlphaPkg = JSON.parse(await readFile(path.join(profDir, 'node_modules', 'demo-plugin-alpha', 'package.json'), 'utf8'));
    assert.equal(restoredAlphaPkg.version, '1.0.0', 'demo-plugin-alpha installed version should be restored to 1.0.0');

    // Verify physical uninstallation: node_modules/demo-plugin-beta is physically removed
    const betaNodeModulesPath = path.join(profDir, 'node_modules', 'demo-plugin-beta');
    assert.equal(existsSync(betaNodeModulesPath), false, 'node_modules/demo-plugin-beta should be physically removed by pnpm during restore');
  });
});

/**
 * dsh-plugin-version-management — core restore & snapshot engine.
 * Pure ESM logic for snapshot creation, restore plan calculation, backup, rollback, and pnpm lifecycle.
 */
import { mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Checks if a candidate package name is an official DeepSeek Harness package.
 */
export function isOfficialPackage(name) {
  return typeof name === 'string' && name.startsWith('@deepseek-ai/');
}

/**
 * Validates that folder is a safe relative folder name inside snapshotDir without path traversal.
 */
export function isSafeSnapshotFolder(snapshotDir, folder) {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  if (path.isAbsolute(folder)) return false;
  if (folder.includes('..') || folder.includes('/') || folder.includes('\\')) return false;
  const resolved = path.resolve(snapshotDir, folder);
  const normalizedSnapDir = path.resolve(snapshotDir);
  if (path.dirname(resolved) !== normalizedSnapDir) return false;
  return true;
}

/**
 * Validates basic snapshot structure.
 */
export function validateSnapshot(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return { valid: false, error: 'Snapshot must be a valid JSON object' };
  }
  if (snap.format !== 'dsh-plugin-snapshot') {
    return { valid: false, error: 'Snapshot format must be "dsh-plugin-snapshot"' };
  }
  if (!snap.dependencies || typeof snap.dependencies !== 'object' || Array.isArray(snap.dependencies)) {
    return { valid: false, error: 'Snapshot dependencies must be an object' };
  }
  if (snap.bundles && !Array.isArray(snap.bundles)) {
    return { valid: false, error: 'Snapshot bundles must be an array' };
  }
  return { valid: true };
}

/**
 * Dynamically resolves DSH version from environment or runtime package.json without hard-coded paths or ctx service dependencies.
 */
export function resolveDshVersion(dshHome, profileDir) {
  if (process.env.DSH_VERSION) return process.env.DSH_VERSION;

  const candidates = [
    path.join(dshHome, 'runtime', 'package.json'),
    path.join(profileDir, '..', '..', 'runtime', 'package.json'),
    path.join(profileDir, 'package.json'),
    path.join(dshHome, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
        const data = JSON.parse(text);
        if (data.version && typeof data.version === 'string') return data.version;
        if (data.dependencies?.['@deepseek-ai/dsh']) return data.dependencies['@deepseek-ai/dsh'];
      }
    } catch {}
  }
  return 'unknown';
}

/**
 * Computes difference between current profile and snapshot.
 * Supports both full restore and subset restore.
 * Note: empty names array [] represents FULL restore (matching client doApply([])).
 */
export function computeRestorePlan(curPkg, snap, names = null) {
  const curDeps = (curPkg && curPkg.dependencies && typeof curPkg.dependencies === 'object') ? curPkg.dependencies : {};
  const curBundles = (curPkg && curPkg.dsh?.profile?.bundles && Array.isArray(curPkg.dsh.profile.bundles)) ? curPkg.dsh.profile.bundles : [];
  const snapDeps = (snap && snap.dependencies && typeof snap.dependencies === 'object') ? snap.dependencies : {};
  const snapBundles = (snap && Array.isArray(snap.bundles)) ? snap.bundles : [];

  // Full restore when names is null, undefined, or empty array []
  const isFull = !names || !Array.isArray(names) || names.length === 0;
  const nameSet = isFull ? null : new Set(names.filter(n => typeof n === 'string'));

  const changes = [];

  if (isFull) {
    for (const [name, targetVer] of Object.entries(snapDeps)) {
      if (isOfficialPackage(name)) continue;
      if (!(name in curDeps)) {
        changes.push({ name, action: 'add', from: null, to: targetVer });
      } else if (curDeps[name] !== targetVer) {
        changes.push({ name, action: 'modify', from: curDeps[name], to: targetVer });
      }
    }
    for (const name of Object.keys(curDeps)) {
      if (isOfficialPackage(name)) continue;
      if (!(name in snapDeps)) {
        changes.push({ name, action: 'remove', from: curDeps[name], to: null });
      }
    }
  } else {
    for (const name of nameSet) {
      if (isOfficialPackage(name)) continue;
      if (name in snapDeps) {
        const targetVer = snapDeps[name];
        if (!(name in curDeps)) {
          changes.push({ name, action: 'add', from: null, to: targetVer });
        } else if (curDeps[name] !== targetVer) {
          changes.push({ name, action: 'modify', from: curDeps[name], to: targetVer });
        }
      } else if (name in curDeps) {
        changes.push({ name, action: 'remove', from: curDeps[name], to: null });
      }
    }
  }

  // Compute target dependencies
  const targetDeps = {};
  // Always retain current official packages as-is
  for (const [k, v] of Object.entries(curDeps)) {
    if (isOfficialPackage(k)) targetDeps[k] = v;
  }

  if (isFull) {
    for (const [k, v] of Object.entries(snapDeps)) {
      if (!isOfficialPackage(k)) targetDeps[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(curDeps)) {
      targetDeps[k] = v;
    }
    for (const name of nameSet) {
      if (isOfficialPackage(name)) continue;
      if (name in snapDeps) {
        targetDeps[name] = snapDeps[name];
      } else {
        delete targetDeps[name];
      }
    }
  }

  // Compute target bundles
  const baseOfficialBundles = curBundles.filter(b => typeof b === 'string' && isOfficialPackage(b));
  let targetBundles = [];

  if (isFull) {
    const snapThirdPartyBundles = snapBundles.filter(b => typeof b === 'string' && !isOfficialPackage(b));
    targetBundles = [...baseOfficialBundles, ...snapThirdPartyBundles];
  } else {
    const newBundleSet = new Set(curBundles);
    for (const name of nameSet) {
      if (isOfficialPackage(name)) continue;
      if (snapBundles.includes(name)) {
        newBundleSet.add(name);
      } else {
        newBundleSet.delete(name);
      }
    }
    targetBundles = Array.from(newBundleSet);
  }

  // Check if identical to current state (noop)
  const curDepKeys = Object.keys(curDeps);
  const targetDepKeys = Object.keys(targetDeps);
  let isNoop = changes.length === 0 && curDepKeys.length === targetDepKeys.length;
  if (isNoop) {
    for (const k of curDepKeys) {
      if (curDeps[k] !== targetDeps[k]) { isNoop = false; break; }
    }
    if (isNoop) {
      if (curBundles.length !== targetBundles.length) {
        isNoop = false;
      } else {
        for (let i = 0; i < curBundles.length; i++) {
          if (curBundles[i] !== targetBundles[i]) { isNoop = false; break; }
        }
      }
    }
  }

  return {
    isFull,
    changes,
    isNoop,
    targetDeps,
    targetBundles,
  };
}

export class RestoreEngine {
  constructor(options = {}) {
    this.profileDir = options.profileDir;
    this.snapshotDir = options.snapshotDir;
    this.dshHome = options.dshHome;
    this.pnpmCmd = options.pnpmCmd || null;
    this.spawnPnpm = options.spawnPnpm || null;
    this.status = { running: false, exitCode: 0, error: null, logTail: '' };
    this.uploadedSnapshots = new Map();
  }

  getStatus() {
    return { ...this.status };
  }

  cacheUploadedSnapshot(key, snap) {
    this.uploadedSnapshots.set(key, snap);
  }

  getUploadedSnapshot(key) {
    return this.uploadedSnapshots.get(key);
  }

  readProfilePkg() {
    const pkgPath = path.join(this.profileDir, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new Error(`Profile package.json missing at: ${pkgPath}`);
    }
    let text;
    try {
      text = readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '');
    } catch (e) {
      throw new Error(`Cannot read profile package.json at ${pkgPath}: ${e.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`Cannot parse profile package.json at ${pkgPath}: ${e.message}`);
    }
  }

  getPluginList() {
    const pkg = this.readProfilePkg();
    const deps = pkg.dependencies || {};
    const plugins = [];
    for (const [name, reqVer] of Object.entries(deps)) {
      let instVer = '';
      try {
        const pPkg = JSON.parse(readFileSync(path.join(this.profileDir, 'node_modules', name, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
        instVer = pPkg.version || '';
      } catch {}
      plugins.push({ name, required: reqVer, installed: instVer || reqVer });
    }
    return plugins;
  }

  async createSnapshot() {
    await mkdir(this.snapshotDir, { recursive: true });
    const now = new Date();
    const isoMs = now.toISOString().replace(/[:T]/g, '-').replace(/\..+/, '') + '-' + String(now.getMilliseconds()).padStart(3, '0');

    let folderName = '';
    let folderPath = '';
    let created = false;
    for (let i = 0; i < 10; i++) {
      const rand = Math.random().toString(36).slice(2, 8);
      folderName = `snapshot-${isoMs}-${rand}`;
      folderPath = path.join(this.snapshotDir, folderName);
      try {
        await mkdir(folderPath, { recursive: false });
        created = true;
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    if (!created) {
      throw new Error(`Failed to create unique snapshot directory in ${this.snapshotDir}`);
    }

    const pkg = this.readProfilePkg();
    const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : [];
    const deps = pkg.dependencies || {};

    const resolvedDeps = {};
    const installedVersions = {};
    const rawDependencies = {};

    for (const [name, reqVer] of Object.entries(deps)) {
      let instVer = '';
      try {
        const pPkg = JSON.parse(readFileSync(path.join(this.profileDir, 'node_modules', name, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
        instVer = pPkg.version || '';
      } catch {}

      installedVersions[name] = instVer || null;
      rawDependencies[name] = reqVer;

      const isLocalOrGit = typeof reqVer === 'string' && /^(file:|git:|git\+|github:|https?:|link:)/i.test(reqVer);
      if (isLocalOrGit) {
        resolvedDeps[name] = reqVer;
      } else if (instVer) {
        resolvedDeps[name] = instVer;
      } else {
        resolvedDeps[name] = typeof reqVer === 'string' ? reqVer.replace(/^[\^~]/, '') : reqVer;
      }
    }

    const snap = {
      format: 'dsh-plugin-snapshot',
      createdAt: now.toISOString(),
      dshHome: this.dshHome,
      profilePath: this.profileDir,
      bundles,
      dependencies: resolvedDeps,
      rawDependencies,
      installedVersions,
    };

    const count = Object.keys(resolvedDeps).length;
    await writeFile(path.join(folderPath, 'dsh-plugin-snapshot.json'), JSON.stringify(snap, null, 2) + '\n', 'utf8');

    const txtLines = [
      `DSH Plugin Snapshot: ${folderName}`,
      `Created At: ${snap.createdAt}`,
      `Profile: ${this.profileDir}`,
      `Plugin Count: ${count}`,
      '----------------------------------------',
      ...Object.entries(resolvedDeps).map(([k, v]) => `  ${k}: ${v}`),
    ];
    await writeFile(path.join(folderPath, 'dsh-plugin-snapshot.txt'), txtLines.join('\n') + '\n', 'utf8');

    return { folderName, folderPath, pluginCount: count, snapshot: snap };
  }

  async applyRestore({ snap, names = null }) {
    if (this.status.running) {
      return { ok: false, error: 'A restore operation is already running' };
    }

    const pkgPath = path.join(this.profileDir, 'package.json');
    const lockPath = path.join(this.profileDir, 'pnpm-lock.yaml');

    let curPkg;
    try {
      curPkg = this.readProfilePkg();
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const plan = computeRestorePlan(curPkg, snap, names);
    if (plan.isNoop) {
      return {
        ok: true,
        status: 'noop',
        message: '当前插件配置与快照一致，无需恢复',
        changes: [],
      };
    }

    const stamp = Date.now();
    const pkgBackupPath = path.join(this.profileDir, `package.json.bak-${stamp}`);
    try {
      await writeFile(pkgBackupPath, JSON.stringify(curPkg, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, error: `Failed to backup package.json: ${err.message}` };
    }

    const hadLockInitially = existsSync(lockPath);
    let lockBackupPath = null;
    if (hadLockInitially) {
      lockBackupPath = path.join(this.profileDir, `pnpm-lock.yaml.bak-${stamp}`);
      try {
        const lockData = await readFile(lockPath);
        await writeFile(lockBackupPath, lockData);
      } catch (err) {
        // If backing up existing lockfile fails, abort immediately before touching package.json
        return { ok: false, error: `Failed to backup existing pnpm-lock.yaml: ${err.message}` };
      }
    }

    const newPkg = { ...curPkg };
    newPkg.dependencies = plan.targetDeps;
    if (!newPkg.dsh) newPkg.dsh = {};
    if (!newPkg.dsh.profile) newPkg.dsh.profile = {};
    newPkg.dsh.profile.bundles = plan.targetBundles;

    await writeFile(pkgPath, JSON.stringify(newPkg, null, 2) + '\n', 'utf8');

    this.status = {
      running: true,
      exitCode: null,
      error: null,
      logTail: `[Restore started] ${plan.changes.length} change(s) queued.\n`,
      startedAt: Date.now(),
    };

    const runPromise = this._runPnpmInstall({
      pkgBackupPath,
      lockBackupPath,
      pkgPath,
      lockPath,
      hadLockInitially,
      changesCount: plan.changes.length,
    });

    return {
      ok: true,
      status: 'started',
      changes: plan.changes,
      backupPath: pkgBackupPath,
      lockBackupPath,
      promise: runPromise,
    };
  }

  async _runPnpmInstall({ pkgBackupPath, lockBackupPath, pkgPath, lockPath, hadLockInitially, changesCount }) {
    const rollback = async () => {
      try {
        if (existsSync(pkgBackupPath)) {
          const bak = await readFile(pkgBackupPath, 'utf8');
          await writeFile(pkgPath, bak, 'utf8');
        }
        if (hadLockInitially && lockBackupPath && existsSync(lockBackupPath)) {
          const bakLock = await readFile(lockBackupPath);
          await writeFile(lockPath, bakLock);
        } else if (!hadLockInitially && existsSync(lockPath)) {
          // Profile originally had no lockfile; clean up lockfile generated during failed run
          await rm(lockPath, { force: true });
        }
      } catch (rbErr) {
        this.status.logTail += `\n[Rollback error] ${rbErr.message}`;
      }
    };

    return new Promise((resolve) => {
      let settled = false;
      const finishOnce = async (actionFn) => {
        if (settled) return;
        settled = true;
        try {
          await actionFn();
        } finally {
          resolve(this.status);
        }
      };

      try {
        let proc;
        if (this.spawnPnpm) {
          proc = this.spawnPnpm(this.profileDir);
        } else if (process.platform === 'win32') {
          const comspec = process.env.ComSpec || 'cmd.exe';
          const rawCmd = this.pnpmCmd || 'pnpm';
          const escapedCmd = rawCmd.includes(' ') && !rawCmd.startsWith('"') ? `"${rawCmd}"` : rawCmd;
          proc = spawn(comspec, ['/d', '/s', '/c', `${escapedCmd} install`], {
            cwd: this.profileDir,
            windowsHide: true,
            env: { ...process.env },
          });
        } else {
          const cmd = this.pnpmCmd || 'pnpm';
          proc = spawn(cmd, ['install'], {
            cwd: this.profileDir,
            windowsHide: true,
            env: { ...process.env },
          });
        }

        proc.stdout?.on('data', (d) => {
          const str = d.toString('utf8');
          this.status.logTail = (this.status.logTail + str).slice(-8000);
        });
        proc.stderr?.on('data', (d) => {
          const str = d.toString('utf8');
          this.status.logTail = (this.status.logTail + str).slice(-8000);
        });

        proc.on('error', (err) => {
          finishOnce(async () => {
            this.status.logTail += `\n[Spawn error] ${err.message}`;
            await rollback();
            this.status = {
              running: false,
              exitCode: 1,
              error: `pnpm install failed to start: ${err.message}. Profile configuration rolled back, but node_modules dependency state may be uncertain.`,
              logTail: this.status.logTail,
              finishedAt: Date.now(),
            };
          });
        });

        proc.on('close', (code) => {
          finishOnce(async () => {
            if (code === 0) {
              this.status = {
                running: false,
                exitCode: 0,
                error: null,
                logTail: this.status.logTail + `\n[Success] Restored ${changesCount} change(s). Please restart DSH.`,
                finishedAt: Date.now(),
              };
            } else {
              await rollback();
              this.status = {
                running: false,
                exitCode: code || 1,
                error: `pnpm install exited with code ${code}. Profile configuration rolled back, but node_modules dependency state may be uncertain.`,
                logTail: this.status.logTail,
                finishedAt: Date.now(),
              };
            }
          });
        });
      } catch (e) {
        finishOnce(async () => {
          await rollback();
          this.status = {
            running: false,
            exitCode: 1,
            error: `Failed to execute pnpm: ${e.message}. Profile configuration rolled back, but node_modules dependency state may be uncertain.`,
            logTail: this.status.logTail + `\n${e.message}`,
            finishedAt: Date.now(),
          };
        });
      }
    });
  }
}

/**
 * dsh-plugin-version-management — host entry (persistent plugin form).
 *
 * Capabilities:
 * - registers the `dsh_plugin_snapshot` / `dsh_plugin_restore` model tools;
 * - serves the settings-page API under /dsh-pvm/* HTTP routes;
 * - discovers the DSH profile directory and a writable snapshot root at
 *   runtime (no hard-coded machine paths — portable for other users).
 *
 * Restore semantics: full restore replaces third-party bundles/dependencies
 * with the snapshot state (official @deepseek-ai/* rows are kept); a subset
 * restore only touches the selected plugin names.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  isSafeSnapshotFolder,
  validateSnapshot,
  resolveDshVersion,
  computeRestorePlan,
  RestoreEngine,
} from './restore-engine.js';

export const name = 'dsh-plugin-version-management';
export const inject = ['tools', 'webServer'];

const RESTORE_PS1 = [
  '# dsh-plugin-version-management offline restore launcher (ASCII only).',
  '# 1) runs dsh-plugin-restore-merge.js: backs up the profile package.json',
  '#    and rewrites its bundles/dependencies from dsh-plugin-snapshot.json;',
  '# 2) runs "pnpm install" inside the profile directory;',
  '# 3) prints fallback "dsh plugin add" commands for a manual reinstall.',
  '# Usage:',
  '#   powershell -NoProfile -ExecutionPolicy Bypass -File dsh-plugin-restore.ps1',
  'param(',
  '  [string]$SnapshotJson = ""',
  ')',
  '$ErrorActionPreference = "Continue"',
  '$Here = Split-Path -Parent $MyInvocation.MyCommand.Path',
  'if ($SnapshotJson -eq "") {',
  '  $SnapshotJson = Join-Path $Here "dsh-plugin-snapshot.json"',
  '}',
  'if (-not (Test-Path $SnapshotJson)) {',
  '  Write-Host "[ERROR] Snapshot JSON not found: $SnapshotJson"',
  '  exit 1',
  '}',
  '$MergeJs = Join-Path $Here "dsh-plugin-restore-merge.js"',
  'if (-not (Test-Path $MergeJs)) {',
  '  Write-Host "[ERROR] Merge script not found: $MergeJs"',
  '  exit 1',
  '}',
  '$node = $null',
  '$c = Get-Command node.exe -ErrorAction SilentlyContinue',
  'if ($c) { $node = $c.Source }',
  'if (-not $node) {',
  '  $c = Get-Command node -ErrorAction SilentlyContinue',
  '  if ($c) { $node = $c.Source }',
  '}',
  'if (-not $node) {',
  '  Write-Host "[ERROR] node.exe not found on PATH"',
  '  exit 1',
  '}',
  '& $node $MergeJs $SnapshotJson',
  'if ($LASTEXITCODE -ne 0) {',
  '  Write-Host "[ERROR] merge failed with exit code $LASTEXITCODE"',
  '  exit $LASTEXITCODE',
  '}',
  '$snap = Get-Content $SnapshotJson -Raw | ConvertFrom-Json',
  '$ProfileDir = $snap.profilePath',
  'if (-not (Test-Path $ProfileDir)) {',
  '  Write-Host "[ERROR] profile directory missing: $ProfileDir"',
  '  exit 1',
  '}',
  '$installExitCode = 0',
  'Push-Location $ProfileDir',
  'try {',
  '  $pnpm = $null',
  '  $c = Get-Command pnpm.cmd -ErrorAction SilentlyContinue',
  '  if ($c) { $pnpm = $c.Source }',
  '  if (-not $pnpm) {',
  '    $c = Get-Command pnpm -ErrorAction SilentlyContinue',
  '    if ($c) { $pnpm = $c.Source }',
  '  }',
  '  $corepack = $null',
  '  if (-not $pnpm) {',
  '    $c = Get-Command corepack.cmd -ErrorAction SilentlyContinue',
  '    if ($c) { $corepack = $c.Source }',
  '    if (-not $corepack) {',
  '      $c = Get-Command corepack -ErrorAction SilentlyContinue',
  '      if ($c) { $corepack = $c.Source }',
  '    }',
  '  }',
  '  if ($pnpm) {',
  '    Write-Host "[INFO] Running: $pnpm install"',
  '    & $pnpm install',
  '    $installExitCode = $LASTEXITCODE',
  '  } elseif ($corepack) {',
  '    Write-Host "[INFO] Running: $corepack pnpm install"',
  '    & $corepack pnpm install',
  '    $installExitCode = $LASTEXITCODE',
  '  } else {',
  '    Write-Host "[ERROR] Neither pnpm nor corepack found on PATH"',
  '    $installExitCode = 1',
  '  }',
  '} finally {',
  '  Pop-Location',
  '}',
  'if ($installExitCode -ne 0) {',
  '  Write-Host "[ERROR] pnpm install failed with exit code $installExitCode"',
  '  Write-Host ""',
  '  Write-Host "Fallback - reinstall one by one (network required):"',
  '  foreach ($p in $snap.dependencies.PSObject.Properties) {',
  '    $v = [string]$p.Value',
  '    $v = $v -replace "[\\^~]", ""',
  '    Write-Host ("  dsh plugin add " + $p.Name + "@" + $v)',
  '  }',
  '  exit $installExitCode',
  '}',
  'Write-Host ""',
  'Write-Host "Done. Restart DSH to load the restored plugins."',
].join('\n');

const RESTORE_MERGE_JS = [
  '// dsh-plugin-version-management offline merge (run by dsh-plugin-restore.ps1).',
  '// Backs up the current profile package.json, then rewrites its bundle list',
  '// and dependencies from the snapshot. Current official @deepseek-ai/* rows',
  '// are kept; every third-party row comes from the snapshot.',
  '"use strict"',
  'const fs = require("fs")',
  'const path = require("path")',
  'const args = process.argv.slice(2)',
  'const snapshotPath = args[0]',
  'if (!snapshotPath || !fs.existsSync(snapshotPath)) {',
  '  console.error("[ERROR] snapshot json missing: " + snapshotPath)',
  '  process.exit(1)',
  '}',
  'function readJson(p, what) {',
  '  let text',
  '  try {',
  '    text = fs.readFileSync(p, "utf8")',
  '    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)',
  '    return JSON.parse(text)',
  '  } catch (e) {',
  '    console.error("[ERROR] cannot parse " + what + " " + p + ": " + e.message)',
  '    process.exit(1)',
  '  }',
  '}',
  'let snap = readJson(snapshotPath, "snapshot")',
  'if (!snap || snap.format !== "dsh-plugin-snapshot") {',
  '  console.error("[ERROR] not a dsh-plugin-snapshot file")',
  '  process.exit(1)',
  '}',
  'const profileDir = snap.profilePath',
  'if (!profileDir || !fs.existsSync(profileDir)) {',
  '  console.error("[ERROR] profile directory missing: " + profileDir)',
  '  process.exit(1)',
  '}',
  'const pkgPath = path.join(profileDir, "package.json")',
  'if (!fs.existsSync(pkgPath)) {',
  '  console.error("[ERROR] package.json missing: " + pkgPath)',
  '  process.exit(1)',
  '}',
  'let pkg = readJson(pkgPath, "package.json")',
  'const here = path.dirname(snapshotPath)',
  'const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")',
  'const backup = path.join(here, "package.json.bak-" + stamp)',
  'fs.writeFileSync(backup, JSON.stringify(pkg, null, 2) + "\\n", "utf8")',
  'console.log("[OK] current package.json backed up to: " + backup)',
  'const lockPath = path.join(profileDir, "pnpm-lock.yaml")',
  'if (fs.existsSync(lockPath)) {',
  '  const lockBackup = path.join(here, "pnpm-lock.yaml.bak-" + stamp)',
  '  try { fs.copyFileSync(lockPath, lockBackup); console.log("[OK] current pnpm-lock.yaml backed up to: " + lockBackup) } catch (e) {}',
  '}',
  'const bundles = (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : []',
  'const deps = (pkg.dependencies && typeof pkg.dependencies === "object") ? pkg.dependencies : {}',
  'const baseBundles = bundles.filter(function (b) { return typeof b === "string" && b.indexOf("@deepseek-ai/") === 0 })',
  'const snapBundles = (Array.isArray(snap.bundles) ? snap.bundles : []).filter(function (b) { return typeof b === "string" && b.indexOf("@deepseek-ai/") !== 0 })',
  'if (!pkg.dsh) pkg.dsh = {}',
  'if (!pkg.dsh.profile) pkg.dsh.profile = {}',
  'pkg.dsh.profile.bundles = baseBundles.concat(snapBundles)',
  'const baseDeps = {}',
  'Object.keys(deps).forEach(function (k) { if (k.indexOf("@deepseek-ai/") === 0) baseDeps[k] = deps[k] })',
  'const newDeps = {}',
  'Object.keys(snap.dependencies || {}).forEach(function (k) { newDeps[k] = snap.dependencies[k] })',
  'Object.keys(baseDeps).forEach(function (k) { if (!(k in newDeps)) newDeps[k] = baseDeps[k] })',
  'pkg.dependencies = newDeps',
  'fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n", "utf8")',
  'console.log("[OK] package.json restored with " + snapBundles.length + " third-party bundle(s)")',
].join('\n');

function resolveProfileDir(config = {}) {
  if (config.profileDir && existsSync(config.profileDir)) return path.resolve(config.profileDir);
  if (config.profilePath && existsSync(config.profilePath)) return path.resolve(config.profilePath);
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.includes('profiles') && existsSync(arg)) {
      return path.resolve(arg);
    }
  }
  if (process.env.DSH_PROFILE_DIR && existsSync(process.env.DSH_PROFILE_DIR)) {
    return path.resolve(process.env.DSH_PROFILE_DIR);
  }
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, 'package.json')) && existsSync(path.join(cwd, 'cordis.patch.yml'))) {
    return cwd;
  }
  if (process.env.DSH_HOME) {
    const desktopP = path.join(process.env.DSH_HOME, 'profiles', 'desktop');
    if (existsSync(desktopP)) return desktopP;
    const webP = path.join(process.env.DSH_HOME, 'profiles', 'web');
    if (existsSync(webP)) return webP;
  }
  return cwd;
}

export function apply(ctx, config = {}) {
  const profileDir = resolveProfileDir(config);
  const dshHome = config.homeDir || process.env.DSH_HOME || path.resolve(profileDir, '../..');
  const snapshotDir = config.snapshotDir || path.resolve(dshHome, 'plugin-version-snapshots');

  const engine = new RestoreEngine({
    profileDir,
    snapshotDir,
    dshHome,
    pnpmCmd: config.pnpmCmd,
    spawnPnpm: config.spawnPnpm,
  });

  // Dynamic candidate detection for dsh-tools without hard-coded machine paths
  let toolsRequire = null;
  const candidates = [
    import.meta.url,
    config.runtimeDir ? path.join(config.runtimeDir, 'package.json') : null,
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'runtime', 'package.json') : null,
    process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'package.json') : null,
    path.join(dshHome, 'runtime', 'package.json'),
    path.join(profileDir, 'package.json'),
    path.join(profileDir, '..', '..', 'runtime', 'package.json'),
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const r = createRequire(c);
      r.resolve('@deepseek-ai/dsh-tools');
      toolsRequire = r;
      break;
    } catch {}
  }

  let defineTool = null;
  if (toolsRequire) {
    try {
      defineTool = toolsRequire('@deepseek-ai/dsh-tools').defineTool;
    } catch {}
  }

  async function createSnapshotWithScripts() {
    const res = await engine.createSnapshot();
    await writeFile(path.join(res.folderPath, 'dsh-plugin-restore.ps1'), RESTORE_PS1, 'utf8');
    await writeFile(path.join(res.folderPath, 'dsh-plugin-restore-merge.js'), RESTORE_MERGE_JS, 'utf8');
    return res;
  }

  // Register WebServer routes under /dsh-pvm
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.webServer.register({
      kind: 'prefix',
      path: '/dsh-pvm',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = url.pathname.replace(/^\/dsh-pvm\/?/, '');
        const method = (req.method || 'GET').toUpperCase();

        const sendJson = (status, obj) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(obj));
        };

        const readBody = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          try { return JSON.parse(raw); } catch { return {}; }
        };

        try {
          if (pathname === 'list-plugins') {
            const dshVersion = resolveDshVersion(dshHome, profileDir);
            return sendJson(200, {
              ok: true,
              info: {
                dshVersion,
                dshHome,
                profilePath: profileDir,
                plugins: engine.getPluginList(),
              },
            });
          }

          if (pathname === 'list-snapshots') {
            await mkdir(snapshotDir, { recursive: true });
            const entries = await readdir(snapshotDir, { withFileTypes: true });
            const list = [];
            for (const ent of entries) {
              if (ent.isDirectory() && ent.name.startsWith('snapshot-')) {
                const sJson = path.join(snapshotDir, ent.name, 'dsh-plugin-snapshot.json');
                let meta = { createdAt: '', pluginCount: 0 };
                try {
                  const s = JSON.parse(readFileSync(sJson, 'utf8').replace(/^\uFEFF/, ''));
                  meta = { createdAt: s.createdAt, pluginCount: Object.keys(s.dependencies || {}).length };
                } catch {}
                list.push({ folderName: ent.name, meta });
              }
            }
            list.sort((a, b) => b.folderName.localeCompare(a.folderName));
            return sendJson(200, { ok: true, snapshots: list });
          }

          if (pathname === 'create-snapshot' && method === 'POST') {
            const resData = await createSnapshotWithScripts();
            return sendJson(200, {
              ok: true,
              folderName: resData.folderName,
              folderPath: resData.folderPath,
              pluginCount: resData.pluginCount,
            });
          }

          if (pathname === 'read-snapshot' && method === 'POST') {
            const body = await readBody();
            if (!body || typeof body.folder !== 'string') {
              return sendJson(400, { ok: false, error: 'folder must be a string' });
            }
            if (!isSafeSnapshotFolder(snapshotDir, body.folder)) {
              return sendJson(400, { ok: false, error: 'Invalid or unsafe snapshot folder' });
            }
            const sJson = path.join(snapshotDir, body.folder, 'dsh-plugin-snapshot.json');
            if (!existsSync(sJson)) return sendJson(404, { ok: false, error: 'snapshot not found' });
            const snap = JSON.parse(readFileSync(sJson, 'utf8').replace(/^\uFEFF/, ''));
            return sendJson(200, { ok: true, snapshot: snap });
          }

          if (pathname === 'restore-preview' && method === 'POST') {
            const body = await readBody();
            if (!body || typeof body !== 'object') {
              return sendJson(400, { ok: false, error: 'Invalid request body' });
            }

            let snap = null;
            let folder = body.folder || 'uploaded';
            if (body.source === 'upload' && body.content) {
              try {
                snap = JSON.parse(body.content);
              } catch (e) {
                return sendJson(400, { ok: false, error: 'Malformed snapshot JSON: ' + e.message });
              }
              const valRes = validateSnapshot(snap);
              if (!valRes.valid) return sendJson(400, { ok: false, error: valRes.error });
              engine.cacheUploadedSnapshot('uploaded', snap);
            } else if (body.folder) {
              if (body.folder === 'uploaded' && engine.getUploadedSnapshot('uploaded')) {
                snap = engine.getUploadedSnapshot('uploaded');
              } else {
                if (!isSafeSnapshotFolder(snapshotDir, body.folder)) {
                  return sendJson(400, { ok: false, error: 'Invalid or unsafe snapshot folder' });
                }
                const sJson = path.join(snapshotDir, body.folder, 'dsh-plugin-snapshot.json');
                if (existsSync(sJson)) {
                  try {
                    snap = JSON.parse(readFileSync(sJson, 'utf8').replace(/^\uFEFF/, ''));
                  } catch (e) {
                    return sendJson(400, { ok: false, error: 'Cannot parse snapshot file: ' + e.message });
                  }
                }
              }
            }

            if (!snap) return sendJson(400, { ok: false, error: 'snapshot not found or specified' });
            const valRes = validateSnapshot(snap);
            if (!valRes.valid) return sendJson(400, { ok: false, error: valRes.error });

            const curPkg = engine.readProfilePkg();
            const plan = computeRestorePlan(curPkg, snap, null);

            return sendJson(200, {
              ok: true,
              folder,
              snapshotCount: Object.keys(snap.dependencies || {}).length,
              changes: plan.changes,
            });
          }

          if (pathname === 'restore-apply' && method === 'POST') {
            const body = await readBody();
            if (!body || typeof body !== 'object') {
              return sendJson(400, { ok: false, error: 'Invalid request body' });
            }

            if (body.names !== undefined && body.names !== null) {
              if (!Array.isArray(body.names) || body.names.some(n => typeof n !== 'string')) {
                return sendJson(400, { ok: false, error: 'names must be an array of strings' });
              }
            }

            let snap = null;
            if (body.source === 'upload' && body.content) {
              try {
                snap = JSON.parse(body.content);
              } catch (e) {
                return sendJson(400, { ok: false, error: 'Malformed snapshot JSON: ' + e.message });
              }
            } else if (body.folder) {
              if (body.folder === 'uploaded' || engine.getUploadedSnapshot(body.folder)) {
                snap = engine.getUploadedSnapshot(body.folder) || engine.getUploadedSnapshot('uploaded');
              } else {
                if (!isSafeSnapshotFolder(snapshotDir, body.folder)) {
                  return sendJson(400, { ok: false, error: 'Invalid or unsafe snapshot folder' });
                }
                const sJson = path.join(snapshotDir, body.folder, 'dsh-plugin-snapshot.json');
                if (existsSync(sJson)) {
                  try {
                    snap = JSON.parse(readFileSync(sJson, 'utf8').replace(/^\uFEFF/, ''));
                  } catch (e) {
                    return sendJson(400, { ok: false, error: 'Cannot parse snapshot file: ' + e.message });
                  }
                }
              }
            } else if (engine.getUploadedSnapshot('uploaded')) {
              snap = engine.getUploadedSnapshot('uploaded');
            }

            if (!snap) return sendJson(400, { ok: false, error: 'snapshot not found or specified' });
            const valRes = validateSnapshot(snap);
            if (!valRes.valid) return sendJson(400, { ok: false, error: valRes.error });

            // Note: empty names array [] represents FULL restore (matching client doApply([]))
            const names = Array.isArray(body.names) ? body.names : null;
            const resData = await engine.applyRestore({ snap, names });

            if (!resData.ok) {
              return sendJson(400, resData);
            }
            if (resData.status === 'noop') {
              return sendJson(200, resData);
            }

            return sendJson(200, {
              ok: true,
              status: 'started',
              changes: resData.changes,
              backupPath: resData.backupPath,
              lockBackupPath: resData.lockBackupPath,
            });
          }

          if (pathname === 'restore-status') {
            return sendJson(200, engine.getStatus());
          }

          return sendJson(404, { ok: false, error: 'unknown route' });
        } catch (err) {
          return sendJson(500, { ok: false, error: String(err?.message || err) });
        }
      },
    });
  }

  // Register tools
  if (defineTool && ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register(defineTool({
        name: 'dsh_plugin_snapshot',
        description: 'Create a snapshot of all currently installed DSH plugins',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async () => {
          const res = await createSnapshotWithScripts();
          return `Snapshot created: ${res.folderName} (${res.pluginCount} plugins) at ${res.folderPath}`;
        },
      }));

      ctx.tools.register(defineTool({
        name: 'dsh_plugin_restore',
        description: 'Restore DSH plugins from a saved snapshot',
        parameters: {
          folder: { type: 'string', description: 'Snapshot folder name (defaults to latest if omitted)' },
          names: { type: 'array', items: { type: 'string' }, description: 'Optional list of plugin names to restore (subset restore). If omitted or empty, restores all plugins.' },
          apply: { type: 'boolean', description: 'If true, actually applies the restore and runs pnpm install. If false or omitted, only previews changes.' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        execute: async (args) => {
          let targetFolder = args?.folder;
          if (!targetFolder || targetFolder === 'latest') {
            try {
              const entries = await readdir(snapshotDir, { withFileTypes: true });
              const snapshotDirs = entries
                .filter(e => e.isDirectory() && e.name.startsWith('snapshot-'))
                .map(e => e.name)
                .sort()
                .reverse();
              if (snapshotDirs.length > 0) {
                targetFolder = snapshotDirs[0];
              }
            } catch {}
          }
          if (!targetFolder) {
            return `No snapshots found in ${snapshotDir}`;
          }
          if (!isSafeSnapshotFolder(snapshotDir, targetFolder)) {
            return `Error: Invalid snapshot folder name "${targetFolder}"`;
          }
          const sJson = path.join(snapshotDir, targetFolder, 'dsh-plugin-snapshot.json');
          if (!existsSync(sJson)) {
            return `Error: Snapshot file not found: ${sJson}`;
          }
          let snap;
          try {
            snap = JSON.parse(readFileSync(sJson, 'utf8').replace(/^\uFEFF/, ''));
          } catch (e) {
            return `Error: Failed to parse snapshot JSON: ${e.message}`;
          }

          let curPkg;
          try {
            curPkg = engine.readProfilePkg();
          } catch (e) {
            return `Error reading profile configuration: ${e.message}`;
          }
          const plan = computeRestorePlan(curPkg, snap, args?.names);

          if (!args?.apply) {
            const lines = [
              `Snapshot: ${targetFolder} (${Object.keys(snap.dependencies || {}).length} plugins)`,
              `Mode: ${plan.isFull ? 'Full restore' : 'Subset restore (' + (args.names || []).join(', ') + ')'}`,
              `Differences found: ${plan.changes.length}`,
            ];
            if (plan.changes.length === 0) {
              lines.push('Current plugins already match snapshot. No changes needed.');
            } else {
              lines.push('Changes to apply:');
              for (const c of plan.changes) {
                lines.push(`  [${c.action}] ${c.name}${c.to ? '@' + c.to : ''}${c.from ? ' (current ' + c.from + ')' : ''}`);
              }
              lines.push('');
              lines.push('To apply this restore, call dsh_plugin_restore with apply: true');
            }
            return lines.join('\n');
          }

          if (plan.isNoop) {
            return `Current plugin configuration already matches snapshot ${targetFolder}. No restore needed.`;
          }

          const res = await engine.applyRestore({ snap, names: args?.names });
          if (!res.ok) {
            return `Restore failed: ${res.error}`;
          }
          if (res.status === 'noop') {
            return res.message;
          }

          const status = await res.promise;
          if (status.exitCode === 0) {
            return `Restore completed successfully from snapshot ${targetFolder} (${plan.changes.length} changes applied).\nBackup saved at: ${res.backupPath}\nPlease restart DSH to load the restored plugins.`;
          } else {
            return `Restore failed with exit code ${status.exitCode}. Profile configuration has been rolled back, but node_modules dependency state may be uncertain.\nError: ${status.error}\n\nLog tail:\n${status.logTail}`;
          }
        },
      }));
    } catch (e) {
      console.warn(`[dsh-plugin-version-management] tool registration warning: ${e.message}`);
    }
  }

  return { engine };
}

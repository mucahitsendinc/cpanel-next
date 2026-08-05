import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApps } from '../lib/probe.mjs';
import { setLocale } from '../lib/i18n/index.mjs';

setLocale('en');

/*
 * Bu testler CANLI bir cPanel 11.136 kutusunda gözlenen davranışı kilitliyor.
 * Yalnızca spesifikasyona bakılarak yazılmış hâlleri yanlıştı.
 */

test('ensure_deps yolu EV-GÖRELİ olmalı (mutlak yol reddediliyor)', async () => {
  // cPanel dokümanı `/home/example/my-app/` diyor ama canlı sunucu bunu
  // "Invalid path" ile reddediyor; yalnızca `my-app` kabul ediliyor.
  const calls = [];
  const ctx = {
    client: {
      user: 'bimtest',
      log() {},
      uapiPost: async (mod, fn, params) => {
        calls.push({ mod, fn, params });
        return { task_id: 't1' };
      },
      uapi: async () => ({}),
    },
  };
  const { installDeps } = await import('../lib/drivers/passenger.mjs');
  await installDeps(ctx, { name: 'patest', path: '/home/bimtest/patest' }, {});

  const call = calls.find((c) => c.fn === 'ensure_deps');
  assert.ok(call, 'ensure_deps çağrılmadı');
  assert.equal(call.params.app_path, 'patest', 'mutlak yol gönderilmiş');
  assert.equal(call.params.type, 'npm');
});

test('ev-göreli yol olduğu gibi geçer', async () => {
  const calls = [];
  const ctx = {
    client: { user: 'u', log() {}, uapiPost: async (m, f, p) => (calls.push({ f, p }), {}), uapi: async () => ({}) },
  };
  const { installDeps } = await import('../lib/drivers/passenger.mjs');
  await installDeps(ctx, { name: 'a', path: 'myapp' }, {});
  assert.equal(calls.find((c) => c.f === 'ensure_deps').p.app_path, 'myapp');
});

test('list_applications yanıtı normalleştiriliyor (canlı biçim)', () => {
  // Canlı sunucudan dönen gerçek biçim.
  const raw = {
    patest: {
      name: 'patest',
      path: '/home/bimtest/patest',
      domain: 'patest.example.com',
      base_uri: '/',
      deployment_mode: 'production',
      enabled: 1,
      envvars: {},
      deps: { npm: 'cd /home/bimtest/patest && /opt/cpanel/ea-nodejs22/bin/npm install', pip: 0, gem: 0 },
      nodejs: '/opt/cpanel/ea-nodejs22/bin/node',
    },
  };
  const [app] = normalizeApps(raw);
  assert.equal(app.name, 'patest');
  assert.equal(app.enabled, true);
  assert.equal(app.nodeVersion, '22', 'ea-nodejs22 yolundan sürüm çıkarılmalı');
  assert.equal(app.nodeBinary, '/opt/cpanel/ea-nodejs22/bin/node');
});

test('CloudLinux venv yolundan da sürüm çıkarılıyor', () => {
  const [app] = normalizeApps([{ name: 'x', path: 'x', nodejs: '/home/u/nodevenv/x/22/bin/node' }]);
  assert.equal(app.nodeVersion, '22');
});

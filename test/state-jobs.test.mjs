import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, MAX_JOBS } from '../lib/ui-server/state.mjs';

/*
 * `state.jobs` hiç temizlenmiyordu. Deploy'da sorun değildi (bir oturumda
 * birkaç iş), ama terminal komut başına bir iş yaratıyor — yoğun bir oturum
 * yüzlerce kayıt bırakır ve `/api/status` hepsini döndürür.
 */

test('biten işler budanıyor', () => {
  const state = createState({});
  for (let i = 0; i < MAX_JOBS + 20; i += 1) {
    const job = state.createJob('shell', { n: i });
    state.finishJob(job, { result: { n: i } });
  }
  assert.ok(state.jobs.size <= MAX_JOBS, `beklenen <= ${MAX_JOBS}, gelen ${state.jobs.size}`);
  state.dispose();
});

test('ÇALIŞAN iş asla atılmıyor', () => {
  /*
   * Çalışan bir işi atmak iki şeyi bozardı: arayüz onu izleyemez hâle
   * gelirdi ve `hasRunningJobs` yanlış cevap verirdi — o da yayın sürerken
   * terminale dönmenin önünü açardı.
   */
  const state = createState({});
  const live = state.createJob('deploy', { uzun: true });
  for (let i = 0; i < MAX_JOBS + 30; i += 1) {
    const job = state.createJob('shell', { n: i });
    state.finishJob(job, { result: {} });
  }
  assert.equal(state.jobs.has(live.id), true, 'çalışan iş silinmiş');
  assert.equal(state.hasRunningJobs(), true);
  state.dispose();
});

test('en eski biten iş önce gidiyor', () => {
  const state = createState({});
  const ids = [];
  for (let i = 0; i < MAX_JOBS + 5; i += 1) {
    const job = state.createJob('shell', { n: i });
    state.finishJob(job, { result: {} });
    ids.push(job.id);
  }
  // İlk yaratılanlar gitmiş, sonuncular durmalı.
  assert.equal(state.jobs.has(ids[ids.length - 1]), true, 'en yeni iş durmalı');
  assert.equal(state.jobs.has(ids[0]), false, 'en eski iş gitmeli');
  state.dispose();
});

test('SSE dinleyicisi olan iş atılmıyor', () => {
  // Tarayıcı hâlâ okuyor olabilir; altından çekmek akışı sessizce keserdi.
  const state = createState({});
  const watched = state.createJob('shell', {});
  state.finishJob(watched, { result: {} });
  watched.listeners.add(() => {});
  for (let i = 0; i < MAX_JOBS + 30; i += 1) {
    const job = state.createJob('shell', { n: i });
    state.finishJob(job, { result: {} });
  }
  assert.equal(state.jobs.has(watched.id), true);
  state.dispose();
});

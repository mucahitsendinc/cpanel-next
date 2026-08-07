import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planZip, DEFAULT_EXCLUDES } from './packager.mjs';

/**
 * HIZLI GÜNCELLEME — yalnızca DEĞİŞEN dosyaları gönderir.
 *
 * Normal yayın her seferinde her şeyi paketleyip yüklüyor ve sunucudaki kod
 * dizinlerini silip yeniden açıyor. Doğru ama pahalı: tek bir satır
 * değiştirdiğinizde de yüz megabayt gidiyor.
 *
 * Burada tutulan şey, en son GÖNDERDİĞİMİZ dosyaların parmak izi. Bir sonraki
 * güncellemede yereldeki liste yeniden hesaplanıyor ve iki liste
 * karşılaştırılıyor: yalnızca içeriği değişenler, yeni eklenenler ve yerelde
 * silinmiş olanlar işleme giriyor.
 *
 * ⚠ MTIME DEĞİL, İÇERİK HASH'İ.
 *
 * Zaman damgasına bakmak bu işi işe yaramaz hâle getirirdi: `next build` ve
 * `vite build` her koşuda BÜTÜN çıktı dosyalarını yeniden yazıyor, yani
 * içerik aynı olsa bile mtime değişiyor. O durumda "hızlı" güncelleme her
 * seferinde tam yükleme yapardı. İçerik hash'i, gerçekten değişmiş olanı
 * ayırt edebilen tek ölçüt.
 */

/** Sunucudaki parmak izi dosyası. Sahiplik işaretinden AYRI tutuluyor. */
export const MANIFEST_FILE = '.cpanel-next-files.json';

export const MANIFEST_VERSION = 1;

/*
 * Bu sayıyı aşan projelerde hızlı güncelleme kapanıyor.
 *
 * Parmak izi dosyası sunucuya `Fileman::save_file_content` ile yazılıyor ve
 * tek bir POST gövdesine sığması gerekiyor. Dosya başına ~70 bayt ile 8000
 * dosya ≈ 560 KB; bunun ötesi hem yazmayı riske atıyor hem de kazancı
 * götürüyor (o boyutta proje zaten tam yayınla daha güvenli).
 */
export const MANIFEST_MAX_FILES = 8000;

/*
 * Hash'in ilk 16 onaltılık hanesi = 64 bit. Bir projedeki birkaç bin dosya
 * için çakışma olasılığı yok denecek kadar küçük, ve tam sha256 saklamak
 * manifest boyutunu iki katına çıkarırdı.
 */
const HASH_CHARS = 16;

/** Tek dosyanın içerik parmak izi. Okunamıyorsa null. */
export function hashFile(abs) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, HASH_CHARS);
  } catch {
    return null;
  }
}

/**
 * Projenin gönderilecek dosyalarının parmak izi.
 *
 * Dosya seçimi `planZip` ile yapılıyor — yani hariç tutma kuralları yayınla
 * BİREBİR aynı. Ayrı bir liste tutmak, iki yerin zamanla ayrışması demekti.
 */
export function fingerprint(cwd, { excludes = DEFAULT_EXCLUDES, allowEnv = [] } = {}) {
  const { included } = planZip(cwd, { excludes, allowEnv });

  const files = {};
  let unreadable = 0;
  for (const rel of included) {
    const hash = hashFile(path.join(cwd, rel));
    if (hash === null) { unreadable += 1; continue; }
    files[rel] = hash;
  }

  const count = Object.keys(files).length;
  return { files, count, unreadable, tooBig: count > MANIFEST_MAX_FILES };
}

/**
 * İki parmak izi arasındaki fark.
 *
 * ⚠ `removed`, YALNIZCA bizim daha önce gönderdiğimiz dosyaları içeriyor.
 * Manifestte olmayan hiçbir şey silinmiyor; sunucuda üretilmiş dosyalar
 * (yüklemeler, loglar, önbellek) hiçbir manifestte yer almadığı için
 * dokunulmaz kalıyor. Bu, `stalePublicFiles` ile aynı ilke.
 *
 * @returns {{added: string[], changed: string[], removed: string[], unchanged: number}}
 */
export function diffManifest(prev, next) {
  const before = prev && typeof prev === 'object' ? prev : {};
  const after = next && typeof next === 'object' ? next : {};

  const added = [];
  const changed = [];
  let unchanged = 0;

  for (const [rel, hash] of Object.entries(after)) {
    if (!(rel in before)) added.push(rel);
    else if (before[rel] !== hash) changed.push(rel);
    else unchanged += 1;
  }

  const removed = Object.keys(before).filter((rel) => !(rel in after));

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchanged,
  };
}

/** Gönderilecek dosyalar — değişenler ve yeniler. */
export function uploadList(diff) {
  return [...diff.added, ...diff.changed].sort();
}

/** Fark anlamlı bir iş içeriyor mu? */
export function hasWork(diff) {
  return diff.added.length + diff.changed.length + diff.removed.length > 0;
}

/**
 * Zaten bilinen dosya listesinin parmak izi.
 *
 * Yayın sonrası kullanılıyor: `makeZip` neyi gönderdiğini zaten söylüyor,
 * projeyi ikinci kez yürümek gereksiz iş olurdu.
 */
export function fingerprintList(cwd, included) {
  const files = {};
  for (const rel of included) {
    const hash = hashFile(path.join(cwd, rel));
    if (hash !== null) files[rel] = hash;
  }
  return files;
}

/**
 * Sunucuya yazılacak manifest gövdesi.
 *
 * Sürüm alanı taşıyor: biçim değişirse eski manifest sessizce yanlış
 * yorumlanmak yerine "tanımıyorum, tam yayın gerekiyor" diyebilsin.
 */
export function buildManifest(files) {
  return { tool: 'cpanel-next', v: MANIFEST_VERSION, at: new Date().toISOString(), files };
}

/**
 * Okunan manifestten dosya haritasını çıkarır.
 *
 * Tanımadığı sürümde ve bozuk gövdede `null` dönüyor — hızlı güncellemenin
 * "elimde sunucunun ne olduğuna dair güvenilir bir kayıt yok" hâli. O durumda
 * çağıran tarafın tam yayına düşmesi gerekiyor; eksik bilgiyle delta
 * göndermek, sunucuda eski dosya bırakmak demek.
 */
export function readManifest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== MANIFEST_VERSION) return null;
  if (!raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) return null;
  return raw.files;
}

/* ------------------------------------------------------------ sunucu tarafı */

/**
 * Manifesti sunucuya yazar.
 *
 * ⚠ HATA YAYINI DÜŞÜRMÜYOR. Manifest bir HIZLANDIRMA kaydı; yazılamazsa tek
 * kayıp, bir sonraki güncellemenin tam yayın olması. Bunun için tamamlanmış
 * bir yayını başarısız saymak orantısız olurdu.
 */
export async function writeRemoteManifest(client, appRoot, files) {
  if (Object.keys(files).length > MANIFEST_MAX_FILES) return { written: false, reason: 'tooBig' };
  const { saveFile, rel } = await import('./remote.mjs');
  try {
    await saveFile(client, rel(appRoot), MANIFEST_FILE, `${JSON.stringify(buildManifest(files))}\n`);
    return { written: true };
  } catch (err) {
    return { written: false, reason: err.message };
  }
}

/** Sunucudaki manifest. Yoksa, bozuksa ya da tanınmayan sürümdeyse null. */
export async function readRemoteManifest(client, appRoot) {
  const { readJson, rel } = await import('./remote.mjs');
  const raw = await readJson(client, rel(appRoot), MANIFEST_FILE).catch(() => null);
  return readManifest(raw);
}

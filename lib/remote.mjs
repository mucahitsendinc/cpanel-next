import { UserError } from './ui.mjs';
import { t } from './i18n/index.mjs';

/**
 * Sunucu tarafı dosya işlemleri.
 *
 * cPanel'in dosya API'si dağınık: bazı işlevler UAPI'de, bazıları yalnızca
 * API2'de, biri de (mkdir) hiçbirinde tam karşılığı olmayan bir biçimde.
 * Burası o dağınıklığı tek bir yerde toplar.
 */

/** Ev dizinine göreli yolu normalleştirir (baştaki/sondaki eğik çizgiler gider). */
export function rel(p) {
  return String(p || '').replace(/^\/+|\/+$/g, '');
}

export function abs(client, p) {
  const r = rel(p);
  return r.startsWith('home/') ? `/${r}` : `/home/${client.user}/${r}`;
}

/**
 * Bir yol var mı?
 *
 * ⚠ `Fileman::get_file_information` NOKTA İLE BAŞLAYAN girdileri GÖREMİYOR.
 * cln02'de doğrulandı: `nodevenv` ve `bimnext` bulunurken var olan
 * `.cpanel-next-run` ve `.cpanel-next-upload` "yok" dönüyordu. Bu araç
 * dizinlerinin neredeyse tamamı nokta ile başladığı için o yol kullanılamaz —
 * ve daha kötüsü, silme doğrulamasını SESSİZCE "silindi" dedirtirdi.
 *
 * Bu yüzden üst dizini `show_hidden` ile listeleyip adı arıyoruz.
 */
export async function exists(client, relPath) {
  const target = rel(relPath);
  if (!target) return true; // ev dizini

  const parts = target.split('/');
  const name = parts.pop();
  const parent = parts.join('/');

  try {
    const entries = await list(client, parent);
    return entries.some((e) => e.name === name);
  } catch {
    // Üst dizin okunamıyorsa (izin/yok) tekil sorguya düşüyoruz; nokta ile
    // başlamayan yollar için bu yeterli.
    try {
      await client.uapi('Fileman', 'get_file_information', { path: target });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Dizin oluşturur (varsa sessizce geçer).
 *
 * ⚠ UAPI'de `Fileman::mkdir` YOK. Tek yol API2. Token'la API2 çalışmazsa
 * çağıran oturum kipine yükseltmeli — hatayı bu yüzden yutmuyoruz.
 */
export async function mkdirp(client, relPath) {
  const parts = rel(relPath).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    const parent = current || '';
    current = current ? `${current}/${part}` : part;
    if (await exists(client, current)) continue;
    try {
      await client.api2('Fileman', 'mkdir', { path: parent, name: part });
    } catch (err) {
      // `mkdir -p` anlamı: zaten varsa başarıdır. cPanel bu durumda
      // "File exists" diye hata döndürüyor — onu hata saymak, aracın kendi
      // çalışma dizinine ikinci kez girmesini imkânsız kılardı.
      if (/exist/i.test(String(err?.message ?? ''))) continue;
      if (await exists(client, current)) continue;
      throw err;
    }
  }
  return current;
}

export async function saveFile(client, dir, file, content) {
  return client.uapiPost('Fileman', 'save_file_content', {
    dir: rel(dir),
    file,
    content,
    from_charset: 'UTF-8',
    to_charset: 'UTF-8',
  });
}

export async function readFile(client, dir, file) {
  const data = await client.uapiPost('Fileman', 'get_file_content', { dir: rel(dir), file });
  return data?.content ?? null;
}

export async function readJson(client, dir, file) {
  const raw = await readFile(client, dir, file).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // node-selector.json gibi dosyalarda başta/sonda çöp olabiliyor.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Zip açar.
 *
 * ⚠ UAPI'de extract YOK — `Fileman::extract_files` diye bir işlev yok.
 * Tek yol API2 `Fileman::fileop op=extract`. (cPanel 136+'daki
 * `ExtractInfo::*` uçları yalnızca ilerleme telemetrisi, açma yapmıyor.)
 */
export async function extractZip(client, zipRelPath, destRelPath) {
  return client.api2('Fileman', 'fileop', {
    op: 'extract',
    sourcefiles: `/${rel(zipRelPath)}`,
    destfiles: `/${rel(destRelPath)}`,
    doubledecode: '0',
  });
}

/**
 * Siler ve SİLİNDİĞİNİ DOĞRULAR.
 *
 * cPanel'in silme çağrısı üretimde sessizce başarısız oldu: dosya silindi
 * sanılırken hâlâ oradaydı ve çalışmaya devam ediyordu. O yüzden her silme
 * sonrası varlık kontrolü yapıyoruz.
 */
export async function remove(client, relPath, { required = true } = {}) {
  const target = rel(relPath);
  try {
    await client.api2('Fileman', 'fileop', {
      op: 'unlink',
      sourcefiles: `/${target}`,
      doubledecode: '0',
    });
  } catch (err) {
    if (required) throw err;
  }
  if (await exists(client, target)) {
    if (required) {
      throw new UserError(t('remote.deleteFailed', { path: target }), t('remote.deleteFailedHint'));
    }
    return false;
  }
  return true;
}

/** Kopyalar (yedek almak için). API2 `fileop op=copy`. */
export async function copy(client, sourceRel, destRel) {
  return client.api2('Fileman', 'fileop', {
    op: 'copy',
    sourcefiles: `/${rel(sourceRel)}`,
    destfiles: `/${rel(destRel)}`,
    doubledecode: '0',
  });
}

/**
 * Birden çok yolu tek çağrıda siler.
 *
 * cPanel virgülle ayrılmış liste kabul ediyor. Her biri için ayrı istek atmak
 * 400 dosyalık bir dizinde dakikalar sürerdi.
 */
export async function removeMany(client, relPaths, { verify = true } = {}) {
  if (!relPaths.length) return { removed: [], failed: [] };
  const list = relPaths.map((p) => `/${rel(p)}`).join(',');
  try {
    await client.api2('Fileman', 'fileop', { op: 'unlink', sourcefiles: list, doubledecode: '0' });
  } catch {
    /* tek tek doğrulama aşağıda */
  }
  if (!verify) return { removed: relPaths, failed: [] };

  const failed = [];
  for (const p of relPaths) {
    if (await exists(client, p)) failed.push(p);
  }
  return { removed: relPaths.filter((p) => !failed.includes(p)), failed };
}

/**
 * Dotenv ailesinden mi? (`.env`, `.env.local`, `.env.production`, `.env.bak-…`)
 *
 * Bu dosyalar pakete HİÇBİR koşulda girmiyor (bkz. packager). Dolayısıyla
 * sunucuda bulunan her dotenv dosyası kullanıcının kendi ürettiği üretim
 * yapılandırmasıdır — silmek yalnızca veri kaybı üretebilir, hiçbir şey
 * kazandırmaz.
 */
function isDotenv(name) {
  return String(name).startsWith('.env');
}

/**
 * Uygulama klasörünü temizler.
 *
 * KALANLAR:
 *   node_modules — bağımlılık kurulumu artımlı çalışsın (CloudLinux'ta bu
 *                  zaten venv'e bir sembolik bağ)
 *   tmp          — Passenger'ın restart dosyası kaybolmasın
 *   .env*        — kullanıcının üretim yapılandırması; pakette hiç yok
 *   keep[]       — çağıranın koruma listesi
 */
export async function cleanDir(client, dirRel, { keep = [] } = {}) {
  const keepSet = new Set(['node_modules', 'tmp', ...keep.map((k) => k.split('/')[0])]);
  const entries = await list(client, dirRel).catch(() => []);
  const targets = entries
    .filter((e) => e.name && e.name !== '.' && e.name !== '..')
    .filter((e) => !keepSet.has(e.name) && !isDotenv(e.name))
    .map((e) => `${rel(dirRel)}/${e.name}`);
  return removeMany(client, targets);
}

/**
 * Dizin listesi (ad + tür + boyut).
 *
 * ⚠ `show_hidden: 1` ŞART. Onsuz cPanel nokta ile başlayan hiçbir girdiyi
 * döndürmüyor — cln02'de `.env`, `.next`, `.htaccess` ve aracın kendi
 * dizinleri listede hiç görünmüyordu. Temizlik adımı bu yüzden nokta
 * dosyalarını hiç silmiyor, `exists()` de onları "yok" sanıyordu.
 */
export async function list(client, relPath) {
  const data = await client.uapi('Fileman', 'list_files', {
    dir: rel(relPath) || `/home/${client.user}`,
    types: 'dir|file',
    show_hidden: 1,
  });
  const rows = Array.isArray(data) ? data : Object.values(data || {});
  return rows.map((r) => ({
    name: r.file ?? r.name,
    type: r.type,
    size: Number(r.size ?? 0),
    mtime: Number(r.mtime ?? 0),
  }));
}

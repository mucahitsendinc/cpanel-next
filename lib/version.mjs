import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Aracın sürümü — TEK KAYNAK.
 *
 * Üç ön yüz de (terminal, web arayüzü, masaüstü) aynı değeri göstermek
 * zorunda. Her biri `package.json`'ı kendi okusaydı, biri ötekinden farklı
 * bir yolu çözdüğünde sessizce ayrışırlardı — ve "hangi sürümü
 * kullanıyorum" sorusu, bir hatayı bildirirken sorulan ilk soru.
 *
 * Değer bir kez okunuyor: dosya çalışma sırasında değişmiyor.
 */
function read() {
  try {
    const raw = fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    /*
     * Okunamıyorsa sürüm gösterimi yüzünden hiçbir şey ÇÖKMEMELİ. Bu bir
     * bilgi satırı; aracın çalışmasıyla ilgisi yok.
     */
    return '0.0.0';
  }
}

export const VERSION = read();

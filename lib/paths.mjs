import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Tüm kalıcı durumun kökü. Tek yerden geçsin ki testlerde yeniden yönlendirilebilsin. */
export const HOME_DIR = process.env.CPANEL_NEXT_HOME
  ? path.resolve(process.env.CPANEL_NEXT_HOME)
  : path.join(os.homedir(), '.cpanel-next');

export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const CAPABILITIES_FILE = path.join(HOME_DIR, 'capabilities.json');
export const BROWSERS_DIR = path.join(HOME_DIR, 'browsers');
export const LOGS_DIR = path.join(HOME_DIR, 'logs');

/** Proje kökündeki (commit edilebilir, sırsız) yapılandırma dosyasının adı. */
export const PROJECT_CONFIG_NAME = '.cpanel-next.json';

/** Sunucudaki dizin adları — hepsi tek yerde, kaçış karakteri sürprizi olmasın. */
export const REMOTE = {
  uploadDir: '.cpanel-next-upload',
  backupDir: '.cpanel-next-backups',
  runDir: '.cpanel-next-run',
  ownerFile: '.cpanel-next-owner.json',
  historyFile: '.cpanel-next-history.json',
};

/**
 * Ev dizinini 0700 ile oluşturur.
 *
 * `mkdir` mode'u umask ile maskelenir, bu yüzden ayrıca açık `chmod` atıyoruz.
 * Burada token duracak; 0755 kalırsa makinedeki her kullanıcı okur.
 */
export function ensureHomeDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(HOME_DIR, 0o700);
  } catch {
    /* Windows'ta anlamsız, sorun değil */
  }
  return HOME_DIR;
}

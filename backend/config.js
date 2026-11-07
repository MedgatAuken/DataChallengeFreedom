// Общая конфигурация бэкенда. Любое значение можно переопределить переменной окружения.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// Подгружаем backend/.env (KEY=VALUE), если он есть. Уже заданные переменные окружения не перезаписываются.
try {
  for (const line of readFileSync(join(here, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// Адрес GET-API организаторов (CQA_Hackathon_Student_Guide, стр. 3) без параметра group_id —
// group_id подставляется при каждом запросе. Ссылка содержит подпись доступа, поэтому хранится
// в backend/.env (не попадает в git). Шаблон — backend/.env.example.
export const ORGANIZER_API_URL = process.env.CQA_API_URL || '';

export const PORT = Number(process.env.PORT || 3000);
export const DEFAULT_GROUP_ID = process.env.CQA_GROUP_ID || 'DEV';
export const DATA_DIR = join(here, 'data');
export const STORE_DIR = join(DATA_DIR, 'store');
export const FRONTEND_DIR = join(here, '..', 'frontend');

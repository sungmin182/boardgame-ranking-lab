// 공용 유틸: HTTP, CSV 파싱, 동시성 제어
import fs from 'node:fs/promises';
import path from 'node:path';

export const UA =
  'LzRankingClone/1.0 (personal board game ranking site; contact: sungmin182@gmail.com)';

/** 지수 백오프 재시도가 붙은 fetch */
export async function get(url, { retries = 4, asText = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err; // 4xx는 아래에서 재시도하지 않고 즉시 던짐
      }
      return asText ? await res.text() : await res.json();
    } catch (err) {
      lastErr = err;
      // 400~499(429 제외)는 재시도해도 의미가 없다
      if (err.status && err.status >= 400 && err.status < 500) throw err;
      if (attempt === retries) break;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 따옴표/줄바꿈을 처리하는 최소 CSV 파서 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

/** 최대 limit개를 동시에 실행하며 순서대로 결과를 반환 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data), 'utf8');
}

/** YYYY-MM-DD */
export function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(n, from = new Date()) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

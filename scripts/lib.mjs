// 공용 유틸: HTTP, CSV 파싱, 동시성 제어
import fs from 'node:fs/promises';
import path from 'node:path';

export const UA =
  'LzRankingClone/1.0 (personal board game ranking site; contact: sungmin182@gmail.com)';

/**
 * 응답이 오지 않는 요청을 끊는 시간(ms).
 *
 * Node의 fetch는 기본 타임아웃이 없다. 연결 하나가 물리면 그 워커는 영원히
 * 기다리고, 동시 실행 4개가 모두 물리면 수집 전체가 아무 로그 없이 멈춘다.
 * 1만 개를 받는 동안 실제로 5075개 지점에서 이렇게 멈춘 적이 있다.
 * 랭킹 CSV는 5~7MB라 넉넉히 잡는다.
 */
const TIMEOUT_MS = 45_000;

/** 지수 백오프 재시도가 붙은 fetch */
export async function get(url, { retries = 4, asText = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        // 타임아웃은 .status 가 없으므로 아래 재시도 분기를 그대로 탄다
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`HTTP ${res.status}`);
        // 429는 "얼마 뒤에 다시 오라"는 답이다. 서버가 값을 주면 그대로 따른다.
        const after = Number(res.headers.get('retry-after'));
        if (Number.isFinite(after) && after > 0) err.retryAfterMs = after * 1000;
        err.throttled = res.status === 429;
        throw err;
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
      // 429는 훨씬 길게 쉰다. 짧게 재시도하면 차단이 더 오래간다.
      const base = err.throttled ? 4000 : 500;
      await sleep(err.retryAfterMs ?? base * 2 ** attempt + Math.random() * 300);
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

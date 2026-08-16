// 1단계: BGG 일별 랭킹 스냅샷을 받아 순위/평점/투표수 변화량을 계산한다.
//
// 데이터 출처: https://github.com/beefsack/bgg-ranking-historicals
//   BGG가 매일 공개하는 랭킹 덤프를 그대로 커밋해 두는 저장소. 2016년치부터
//   존재하므로 "직접 스냅샷을 몇 달 쌓는" 과정 없이 과거 대비 변화량을 바로 구할 수 있다.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { get, parseCsv, ensureDir, writeJson, ymd, daysAgo } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'ranks');
const RAW = 'https://raw.githubusercontent.com/beefsack/bgg-ranking-historicals/master';

/** 과거 스냅샷과의 비교 구간(일). 표의 변동 열과 상승세 점수에 쓴다. */
export const OFFSETS = [7, 30, 365];

/**
 * 순위 추이 그래프용 표본.
 *
 * CSV 한 개가 5~7MB라 월 단위(60개)는 내려받는 양이 과하다. 분기 단위로 5년,
 * 즉 21개면 작은 그래프에서 추세를 읽기에 충분하다.
 */
const HISTORY_MONTHS = 60;
const HISTORY_STEP_MONTHS = 3;

function historyTargets(baseDate) {
  const out = [];
  for (let m = HISTORY_MONTHS; m >= 0; m -= HISTORY_STEP_MONTHS) {
    const d = new Date(`${baseDate}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - m);
    out.push(ymd(d));
  }
  return out;
}

async function fetchSnapshot(date) {
  const file = path.join(CACHE, `${date}.csv`);
  try {
    return parseCsv(await fs.readFile(file, 'utf8'));
  } catch {
    /* 캐시 없음 → 내려받는다 */
  }

  const text = await get(`${RAW}/${date}.csv`, { asText: true });
  await ensureDir(CACHE);
  await fs.writeFile(file, text, 'utf8');
  return parseCsv(text);
}

/** 해당 날짜 주변으로 최대 maxBack일 거슬러 올라가며 존재하는 스냅샷을 찾는다 */
async function fetchNearest(date, maxBack = 8) {
  for (let i = 0; i < maxBack; i++) {
    const d = ymd(daysAgo(i, new Date(`${date}T00:00:00Z`)));
    try {
      const rows = await fetchSnapshot(d);
      return { date: d, rows };
    } catch (err) {
      if (err.status === 404) continue;
      throw err;
    }
  }
  return null;
}

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function index(rows) {
  const map = new Map();
  for (const r of rows) {
    const rank = num(r.Rank);
    // Rank 0 = 미순위(투표 30개 미만). 순위 변화 비교 대상에서 제외한다.
    map.set(r.ID, {
      rank: rank && rank > 0 ? rank : null,
      average: num(r.Average),
      bayes: num(r['Bayes average']),
      votes: num(r['Users rated']),
    });
  }
  return map;
}

export async function syncRanks({ limit = 1500 } = {}) {
  const today = await fetchNearest(ymd(new Date()));
  if (!today) throw new Error('최신 랭킹 스냅샷을 찾을 수 없습니다.');
  console.log(`[ranks] 기준일 ${today.date} · ${today.rows.length}개 게임`);

  const past = {};
  for (const off of OFFSETS) {
    const snap = await fetchNearest(ymd(daysAgo(off, new Date(`${today.date}T00:00:00Z`))));
    if (snap) {
      past[off] = index(snap.rows);
      console.log(`[ranks] -${off}일 기준 ${snap.date} 로드`);
    } else {
      console.warn(`[ranks] -${off}일 스냅샷 없음 (건너뜀)`);
    }
  }

  const games = today.rows
    .map((r) => ({
      id: Number(r.ID),
      name: r.Name,
      year: num(r.Year),
      rank: num(r.Rank),
      average: num(r.Average),
      bayes: num(r['Bayes average']),
      votes: num(r['Users rated']),
      url: r.URL,
      thumb: r.Thumbnail,
    }))
    .filter((g) => g.rank && g.rank > 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);

  // ── 5년 추이 ──────────────────────────────────────────
  // 날짜는 게임마다 같으므로 위쪽에 한 번만 두고, 게임에는 순위 배열만 담는다.
  // (3000개 × 21점을 객체로 담으면 파일이 몇 배로 불어난다)
  const histDates = [];
  const histMaps = [];
  for (const target of historyTargets(today.date)) {
    const snap = await fetchNearest(target);
    if (!snap) continue;
    if (histDates.includes(snap.date)) continue; // 같은 스냅샷이 두 번 잡히는 경우
    histDates.push(snap.date);
    histMaps.push(index(snap.rows));
  }
  console.log(`[ranks] 추이 표본 ${histDates.length}개 (${histDates[0]} ~ ${histDates.at(-1)})`);

  for (const g of games) {
    const id = String(g.id);
    g.hist = histMaps.map((m) => m.get(id)?.rank ?? null);
  }

  for (const g of games) {
    const id = String(g.id);
    g.delta = {};
    for (const off of OFFSETS) {
      const prev = past[off]?.get(id);
      if (!prev) continue;
      g.delta[off] = {
        // 양수 = 순위가 올라감(숫자가 작아짐)
        rank: prev.rank == null ? null : prev.rank - g.rank,
        rankPct:
          prev.rank == null ? null : Math.round(((prev.rank - g.rank) / prev.rank) * 1000) / 10,
        votes: prev.votes == null ? null : g.votes - prev.votes,
        votesPct:
          prev.votes ? Math.round(((g.votes - prev.votes) / prev.votes) * 1000) / 10 : null,
        bayes: prev.bayes == null ? null : Math.round((g.bayes - prev.bayes) * 1000) / 1000,
      };
    }
  }

  await writeJson(path.join(ROOT, 'data', 'ranks.json'), { date: today.date, histDates, games });
  console.log(`[ranks] data/ranks.json 저장 (${games.length}개)`);
  return { date: today.date, histDates, games };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const limit = Number(process.env.LIMIT || 1500);
  syncRanks({ limit }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

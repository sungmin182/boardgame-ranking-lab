// 3단계: 랭킹 스냅샷 + 상세 캐시를 프론트엔드가 바로 먹는 단일 JSON으로 합친다.
//
// 출력: data/games.json
//   { date, count, facets: {mechanics, categories, designers}, games: [...] }

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, writeJson } from './lib.mjs';
import { OFFSETS } from './sync-ranks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'details');

/** 상위 N개 값만 남긴 패싯 목록(필터 드롭다운 채우기용) */
function facet(games, key, min = 3) {
  const counts = new Map();
  for (const g of games) {
    for (const v of g[key] ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

export async function build() {
  const ranks = await readJson(path.join(ROOT, 'data', 'ranks.json'));
  if (!ranks) throw new Error('data/ranks.json 이 없습니다. sync-ranks.mjs 먼저 실행하세요.');

  const korean = (await readJson(path.join(ROOT, 'data', 'korean-names.json'), {})) ?? {};

  const games = [];
  let missing = 0;

  for (const r of ranks.games) {
    const d = await readJson(path.join(CACHE, `${r.id}.json`));
    if (!d) {
      missing++;
      continue; // 상세가 없으면 난이도/인원 필터가 불가능하므로 제외
    }

    games.push({
      id: r.id,
      name: d.name ?? r.name,
      kor: korean[r.id] ?? null,
      year: d.year ?? r.year,
      rank: r.rank,
      href: d.href ?? r.url,
      image: d.image,
      thumb: r.thumb,
      desc: d.desc,

      // 평점 (일별 스냅샷 값을 정본으로 사용해 델타와 기준을 맞춘다)
      bayes: r.bayes,
      average: r.average,
      votes: r.votes,
      stddev: d.stddev,
      // 긱 순위(베이즈)와 유저 평균의 차이. 저평가/고평가 탐지용
      margin: r.average != null && r.bayes != null ? +(r.average - r.bayes).toFixed(3) : null,

      // 스펙
      weight: d.weight != null ? +d.weight.toFixed(2) : null,
      weightVotes: d.weightVotes,
      minPlayers: d.minPlayers,
      maxPlayers: d.maxPlayers,
      best: d.best,
      recommended: d.recommended,
      minTime: d.minTime,
      maxTime: d.maxTime,
      minAge: d.minAge,
      langDep: d.langDep,

      // 커뮤니티 규모
      owned: d.owned,
      wishing: d.wishing,
      plays: d.plays,

      // 분류
      categories: d.categories,
      mechanics: d.mechanics,
      designers: d.designers,
      subranks: d.subranks,

      // 변화량
      delta: r.delta,
    });
  }

  const out = {
    date: ranks.date,
    builtAt: new Date().toISOString(),
    offsets: OFFSETS,
    count: games.length,
    facets: {
      mechanics: facet(games, 'mechanics'),
      categories: facet(games, 'categories'),
      designers: facet(games, 'designers', 4),
    },
    games,
  };

  const file = path.join(ROOT, 'data', 'games.json');
  await writeJson(file, out);
  const { size } = await fs.stat(file);
  console.log(
    `[build] data/games.json 저장 · ${games.length}개 · ${(size / 1024 / 1024).toFixed(2)}MB` +
      (missing ? ` (상세 없어 제외 ${missing}개)` : '')
  );
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}

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

  // 한글명은 BGG에 등록된 발매명을 기본으로 쓰고,
  // data/korean-names.json 에 적힌 값이 있으면 그것으로 덮어쓴다(직접 고치기 위한 파일).
  const overrides = (await readJson(path.join(ROOT, 'data', 'korean-names.json'), {})) ?? {};

  // 국내 발매사 목록 (data/kr-publishers.json). 비교는 소문자로 맞춰서 한다.
  const krPubFile = await readJson(path.join(ROOT, 'data', 'kr-publishers.json'), {});
  const krPubs = new Map(
    (krPubFile?.publishers ?? []).map((name) => [name.toLowerCase(), name])
  );

  const games = [];
  let missing = 0;
  let fromBgg = 0;
  let fromOverride = 0;
  let krCount = 0;

  for (const r of ranks.games) {
    const d = await readJson(path.join(CACHE, `${r.id}.json`));
    if (!d) {
      missing++;
      continue; // 상세가 없으면 난이도/인원 필터가 불가능하므로 제외
    }

    const override = overrides[r.id];
    const kor = override ?? d.korNames?.[0] ?? null;
    if (override) fromOverride++;
    else if (kor) fromBgg++;

    // 국내 정발 판정: 한글 발매명이 있거나, 국내 발매사가 붙어 있거나.
    // 둘 다 BGG가 갖고 있는 자료다(국내 사이트를 긁지 않는다).
    const krPub = (d.publishers ?? [])
      .map((p) => krPubs.get(p?.toLowerCase?.()))
      .find(Boolean) ?? null;
    const kr = Boolean(kor || krPub);
    if (kr) krCount++;

    games.push({
      id: r.id,
      name: d.name ?? r.name,
      kor,
      // 검색용 별칭(변형판 이름 등). 대표 이름과 겹치는 것은 뺀다.
      korAlt: (d.korNames ?? []).filter((n) => n !== kor),
      // 국내 정발 여부와, 근거가 된 발매사 이름
      kr,
      krPub,
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
      // 5년 순위 추이. 날짜는 최상위 histDates 와 같은 순서다.
      hist: r.hist,
    });
  }

  const out = {
    date: ranks.date,
    builtAt: new Date().toISOString(),
    offsets: OFFSETS,
    histDates: ranks.histDates ?? [],
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
  console.log(
    `[build] 한글명 ${fromBgg + fromOverride}개 (BGG ${fromBgg} + 직접 지정 ${fromOverride})`
  );
  console.log(
    `[build] 국내 정발로 판정 ${krCount}개 (한글명 또는 국내 발매사 ${krPubs.size}곳 기준)`
  );
  // 상위 100위권은 대부분 정발되어 있어 BGG 한글명이 붙는다. 0에 가까우면
  // 상세 캐시가 옛 형식이라는 뜻이다(CI 캐시 복원 사고가 실제로 있었다).
  if (games.length > 200 && fromBgg < 50) {
    console.warn(
      `[build] 경고: BGG 한글명이 ${fromBgg}개뿐입니다. cache/details 가 옛 형식일 수 있습니다. ` +
        `TTL_HOURS=0 으로 sync-details 를 다시 돌려보세요.`
    );
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build();
}

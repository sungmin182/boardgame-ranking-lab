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

  /*
   * 손으로 채워 넣는 값(data/game-overrides.json).
   *
   * 평가가 적은 게임은 BGG 항목이 덜 채워져 있어 인원·시간이 0으로 비어 있다.
   * 그러면 수업 계획에서 모둠 수도 차시 초과도 계산할 수 없다.
   * 상자에 적힌 값을 여기에 넣어 두면 그쪽이 우선한다.
   */
  const specOverrides = (await readJson(path.join(ROOT, 'data', 'game-overrides.json'), {})) ?? {};

  // 국내 발매사 목록 (data/kr-publishers.json). 비교는 소문자로 맞춰서 한다.
  const krPubFile = await readJson(path.join(ROOT, 'data', 'kr-publishers.json'), {});
  const krPubs = new Map(
    (krPubFile?.publishers ?? []).map((name) => [name.toLowerCase(), name])
  );

  /*
   * 순위 목록 + 따로 지정한 게임(data/extra-games.json).
   *
   * 지정 게임은 랭킹 덤프에 없거나(평가 30개 미만이라 순위가 없음) 수집 상한
   * 밖이라 그냥 두면 영영 안 들어온다. 국내 발매 교육용 게임이 대개 그렇다.
   * 순위 목록에 이미 있으면 중복해서 넣지 않는다.
   */
  const extraIds = (await readJson(path.join(ROOT, 'data', 'extra-games.json'), {}))?.ids ?? [];
  const inRanks = new Set(ranks.games.map((g) => g.id));
  const extras = extraIds
    .map(Number)
    .filter((id) => Number.isFinite(id) && !inRanks.has(id))
    .map((id) => ({ id, extra: true }));

  const games = [];
  let missing = 0;
  let fromBgg = 0;
  let fromOverride = 0;
  let krCount = 0;
  let extraUsed = 0;
  let overrideUsed = 0;

  for (const r of [...ranks.games, ...extras]) {
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
    if (r.extra) extraUsed++;

    /** 손으로 채운 값 → BGG 값 → (0이면) 값 없음 */
    const ov = specOverrides[r.id] ?? {};
    const spec = (key, bggValue) => ov[key] ?? (bggValue || null);
    if (Object.keys(ov).some((k) => k !== '_이름')) overrideUsed++;

    /*
     * 따로 지정한 게임은 랭킹 스냅샷에 없으므로 평점·순위를 상세 캐시에서 가져온다.
     * 순위 자체가 없는 게임(평가 30개 미만)은 rank 가 0으로 오므로 null 로 바꾼다 —
     * 0위처럼 보이면 정렬과 필터가 엉킨다.
     */
    const rank = r.extra ? (d.rank > 0 ? d.rank : null) : r.rank;
    const bayes = r.extra ? d.bayes : r.bayes;
    const average = r.extra ? d.average : r.average;
    const votes = r.extra ? d.votes : r.votes;

    games.push({
      id: r.id,
      name: d.name ?? r.name,
      kor,
      // 검색용 별칭(변형판 이름 등). 대표 이름과 겹치는 것은 뺀다.
      korAlt: (d.korNames ?? []).filter((n) => n !== kor),
      // 국내 정발 여부와, 근거가 된 발매사 이름
      kr,
      krPub,
      // 순위 목록 밖에서 따로 가져온 게임인지(화면에서 "순위 없음"으로 알린다)
      extra: r.extra ? true : undefined,
      year: d.year ?? r.year,
      rank,
      href: d.href ?? r.url,
      image: d.image,
      thumb: r.extra ? d.image : r.thumb,
      desc: d.desc,

      // 평점 (일별 스냅샷 값을 정본으로 사용해 델타와 기준을 맞춘다)
      bayes,
      average,
      votes,
      stddev: d.stddev,
      // 긱 순위(베이즈)와 유저 평균의 차이. 저평가/고평가 탐지용
      margin: average != null && bayes != null ? +(average - bayes).toFixed(3) : null,

      /*
       * 스펙
       *
       * BGG는 값이 없을 때 0을 준다. 인원 0명, 시간 0분, 난이도 0은 있을 수 없는
       * 값인데(난이도 척도는 1~5다) 그대로 두면 화면에 0으로 찍히고 정렬에서도
       * 맨 앞에 온다. 평가가 적은 국내 게임이 대개 이 경우라 값 없음으로 바꾼다.
       * spec() 이 손으로 채운 값(game-overrides.json)을 먼저 쓰고, 없으면 BGG 값,
       * 그것도 0이면 null 을 돌려준다.
       */
      weight: spec('weight', d.weight) != null ? +spec('weight', d.weight).toFixed(2) : null,
      weightVotes: d.weightVotes,
      minPlayers: spec('minPlayers', d.minPlayers),
      maxPlayers: spec('maxPlayers', d.maxPlayers),
      best: d.best,
      recommended: d.recommended,
      minTime: spec('minTime', d.minTime),
      maxTime: spec('maxTime', d.maxTime),
      minAge: spec('minAge', d.minAge),
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
  if (overrideUsed) console.log(`[build] 손으로 채운 스펙 ${overrideUsed}개 적용`);
  if (extras.length) {
    console.log(
      `[build] 따로 지정한 게임 ${extraUsed}/${extras.length}개 포함` +
        (extraUsed < extras.length ? ' (나머지는 아직 상세를 못 받았습니다)' : '')
    );
  }
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

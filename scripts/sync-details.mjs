// 2단계: 게임별 상세 정보(난이도/추천 인원/플레이타임/메커니즘 등)를 수집한다.
//
// BGG 공식 XML API(/xmlapi2)는 2025년부터 Authorization 토큰이 필수라 401을 돌려준다.
// 대신 BGG 웹사이트 자신이 사용하는 공개 JSON 엔드포인트 두 개를 쓴다.
//   - geekitems   : 정적 정보(인원/시간/메커니즘/카테고리/디자이너/이미지)
//   - dynamicinfo : 매일 바뀌는 정보(순위/평점/난이도 투표/추천 인원 투표)
// 토큰을 발급받았다면 BGG_TOKEN 환경변수를 넣어 공식 API 경로로 전환할 수 있다(README 참고).

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { get, pool, readJson, writeJson, sleep } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'details');

const GEEKITEMS = (id) =>
  `https://api.geekdo.com/api/geekitems?objectid=${id}&objecttype=thing&subtype=boardgame`;
const DYNAMIC = (id) => `https://api.geekdo.com/api/dynamicinfo?objectid=${id}&objecttype=thing`;

const names = (links, key) => (links?.[key] ?? []).map((l) => l.name);
const n = (v) => {
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : null;
};

/** 추천 인원 투표 결과를 인원수 배열로 펼친다. [{min,max}] → [3,4] */
function expandPlayerRanges(ranges) {
  const out = new Set();
  for (const r of ranges ?? []) {
    const min = Number(r.min);
    const max = Number(r.max);
    if (!Number.isFinite(min)) continue;
    for (let i = min; i <= (Number.isFinite(max) ? max : min); i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** 두 응답을 우리가 쓸 필드만 남긴 슬림 객체로 정규화 */
export function normalize(id, item, dyn) {
  const polls = dyn?.polls ?? {};
  const stats = dyn?.stats ?? {};
  const overall = (dyn?.rankinfo ?? []).find((r) => r.rankobjectid === 1 || r.subdomain === null);

  return {
    id: Number(id),
    name: item?.name ?? null,
    korName: null, // 한글명은 data/korean-names.json 에서 수동/반자동으로 덧입힌다
    year: n(item?.yearpublished),
    desc: item?.short_description ?? null,
    image: item?.images?.square200 ?? item?.imageurl ?? null,
    href: item?.href ?? null,

    minPlayers: n(item?.minplayers),
    maxPlayers: n(item?.maxplayers),
    minTime: n(item?.minplaytime),
    maxTime: n(item?.maxplaytime),
    minAge: n(item?.minage),

    weight: n(polls?.boardgameweight?.averageweight),
    weightVotes: n(polls?.boardgameweight?.votes),
    best: expandPlayerRanges(polls?.userplayers?.best),
    recommended: expandPlayerRanges(polls?.userplayers?.recommended),
    playerVotes: n(polls?.userplayers?.totalvotes),
    langDep: polls?.languagedependence ?? null,

    rank: n(overall?.rank),
    subranks: (dyn?.rankinfo ?? [])
      .filter((r) => r.subdomain)
      .map((r) => ({ name: r.veryshortprettyname?.trim(), rank: n(r.rank) })),

    average: n(stats?.average),
    bayes: n(stats?.baverage),
    votes: n(stats?.usersrated),
    stddev: n(stats?.stddev),
    owned: n(stats?.numowned),
    wishing: n(stats?.numwish),
    plays: n(stats?.numplays),
    comments: n(stats?.numcomments),

    categories: names(item?.links, 'boardgamecategory'),
    mechanics: names(item?.links, 'boardgamemechanic'),
    designers: names(item?.links, 'boardgamedesigner'),
    publishers: names(item?.links, 'boardgamepublisher').slice(0, 5),
    families: names(item?.links, 'boardgamefamily').slice(0, 10),
    isExpansion: (item?.links?.expandsboardgame ?? []).length > 0,

    fetchedAt: new Date().toISOString(),
  };
}

/** 캐시가 신선하면 재사용하고, 아니면 두 엔드포인트를 호출한다 */
async function fetchDetail(id, { ttlHours }) {
  const file = path.join(CACHE, `${id}.json`);
  const cached = await readJson(file);
  if (cached?.fetchedAt) {
    const ageHours = (Date.now() - Date.parse(cached.fetchedAt)) / 36e5;
    if (ageHours < ttlHours) return { detail: cached, cached: true };
  }

  const [gi, dyn] = await Promise.all([get(GEEKITEMS(id)), get(DYNAMIC(id))]);
  const detail = normalize(id, gi?.item, dyn?.item);
  await writeJson(file, detail);
  await sleep(120); // BGG 서버에 대한 최소한의 예의
  return { detail, cached: false };
}

export async function syncDetails(ids, { concurrency = 4, ttlHours = 20 } = {}) {
  let done = 0;
  let fetched = 0;
  let failed = 0;

  const results = await pool(ids, concurrency, async (id) => {
    try {
      const { detail, cached } = await fetchDetail(id, { ttlHours });
      if (!cached) fetched++;
      return detail;
    } catch (err) {
      failed++;
      console.warn(`[details] ${id} 실패: ${err.message}`);
      return null;
    } finally {
      done++;
      if (done % 50 === 0 || done === ids.length) {
        console.log(`[details] ${done}/${ids.length} (신규 ${fetched}, 실패 ${failed})`);
      }
    }
  });

  return results.filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ranks = await readJson(path.join(ROOT, 'data', 'ranks.json'));
  if (!ranks) throw new Error('먼저 sync-ranks.mjs를 실행하세요.');
  const limit = Number(process.env.LIMIT || 1000);
  const ids = ranks.games.slice(0, limit).map((g) => g.id);
  await syncDetails(ids, { concurrency: Number(process.env.CONCURRENCY || 4) });
}

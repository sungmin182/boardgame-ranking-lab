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
import { DEFAULT_LIMIT } from './sync-ranks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache', 'details');

/**
 * 캐시 파일의 형식 버전.
 *
 * normalize()가 만드는 필드를 바꿀 때마다 올린다. 버전이 다른 캐시는 아직
 * 유효기간이 남아 있어도 버리고 다시 받는다. 이게 없으면 CI가 복원한 옛 캐시
 * 때문에 새 필드가 영영 채워지지 않는다(실제로 korNames 추가 때 그랬다).
 */
const SCHEMA = 4;

const GEEKITEMS = (id) =>
  `https://api.geekdo.com/api/geekitems?objectid=${id}&objecttype=thing&subtype=boardgame`;
const DYNAMIC = (id) => `https://api.geekdo.com/api/dynamicinfo?objectid=${id}&objecttype=thing`;

const names = (links, key) => (links?.[key] ?? []).map((l) => l.name);
const n = (v) => {
  const x = Number.parseFloat(v);
  return Number.isFinite(x) ? x : null;
};

/**
 * BGG가 갖고 있는 다른 언어 발매명 중 한글이 든 것을 추린다.
 *
 * 한 게임에 여러 개가 달릴 수 있다(아줄 → "아줄", "아줄 미니"). 변형판 이름은
 * 대개 기본판 이름에 수식어가 붙은 형태라, 짧은 것을 대표 이름으로 삼는다.
 */
function koreanNames(item) {
  const all = [item?.primaryname, ...(item?.alternatenames ?? [])];
  const found = all
    .map((n) => (typeof n === 'string' ? n : n?.name))
    .filter((n) => n && /[가-힣]/.test(n))
    .map((n) => n.trim());
  return [...new Set(found)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

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
    schema: SCHEMA,
    id: Number(id),
    name: item?.name ?? null,
    // BGG에 등록된 한국어 발매명. 첫 항목을 대표로 쓰고,
    // data/korean-names.json 에 같은 id가 있으면 그쪽이 우선한다.
    korNames: koreanNames(item),
    year: n(item?.yearpublished),
    desc: item?.short_description ?? null,
    // square200 은 /200x200/ 정사각 크롭이라 가로로 긴 표지의 양옆이 잘린다.
    // imageurl@2x 는 fit-in/492x600 이라 비율을 지키고 해상도도 충분하다.
    image: item?.['imageurl@2x'] ?? item?.imageurl ?? item?.images?.previewthumb ?? null,
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
    // 상위 5개만 남기면 국내 퍼블리셔가 잘려나간다. 인기작은 발매사가 20곳이 넘고
    // 한국 발매사(Korea Boardgames, BoardM 등)는 대개 뒤쪽에 붙기 때문이다.
    // 실제로 3001개 중 1845개가 5개에서 잘려 정발 여부를 판정할 수 없었다.
    publishers: names(item?.links, 'boardgamepublisher'),
    families: names(item?.links, 'boardgamefamily').slice(0, 10),
    isExpansion: (item?.links?.expandsboardgame ?? []).length > 0,

    fetchedAt: new Date().toISOString(),
  };
}

/** 캐시가 신선하면 재사용하고, 아니면 두 엔드포인트를 호출한다 */
async function fetchDetail(id, { ttlHours }) {
  const file = path.join(CACHE, `${id}.json`);
  const cached = await readJson(file);
  if (cached?.fetchedAt && cached.schema === SCHEMA) {
    const ageHours = (Date.now() - Date.parse(cached.fetchedAt)) / 36e5;
    if (ageHours < ttlHours) return { detail: cached, cached: true };
  }

  const [gi, dyn] = await Promise.all([get(GEEKITEMS(id)), get(DYNAMIC(id))]);
  const detail = normalize(id, gi?.item, dyn?.item);
  await writeJson(file, detail);
  await sleep(PACE_MS);
  return { detail, cached: false };
}

/**
 * 요청 하나가 끝난 뒤 쉬는 시간(ms).
 *
 * 120ms + 동시 4개로 1만 개를 받다가 5천 개 지점에서 429(요청 과다)를 맞았다.
 * api.geekdo.com은 BGG가 문서로 공개한 API가 아니라 자사 사이트용 엔드포인트라
 * 한도가 명시돼 있지 않다. 차단당하는 쪽이 훨씬 손해이므로 넉넉히 쉰다.
 */
const PACE_MS = Number(process.env.PACE_MS || 350);

/**
 * 한 번 실행에서 새로 받을 최대 개수.
 *
 * BGG는 한도를 문서로 밝히지 않지만, 일정량을 넘기면 429를 돌려주고 한동안
 * 풀어주지 않는다. 1만 개를 한 번에 받으려다 두 번 막혔다(5000개 부근, 그리고
 * 재개 후 475개 부근). 막히면 그 뒤 요청이 전부 버려지므로 밀어붙이는 쪽이 손해다.
 *
 * 그래서 실행당 상한을 두고 나머지는 다음 실행으로 넘긴다. 캐시가 없는 게임은
 * 다음 회차에 자연히 1순위가 되므로, 매일 도는 CI가 며칠에 걸쳐 채운다.
 * 그동안 사이트는 이미 받은 만큼으로 정상 동작한다(build가 상세 없는 게임을 건너뛴다).
 */
const MAX_NEW = Number(process.env.MAX_NEW || 1200);

export async function syncDetails(ids, { concurrency = 2, ttlHours = 336 } = {}) {
  let done = 0;
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  // 429가 연달아 나오면 이미 막힌 것이다. 남은 요청을 계속 던져도 다 버려진다.
  let consecutive429 = 0;
  let stop = false;

  const results = await pool(ids, concurrency, async (id) => {
    if (stop) {
      skipped++;
      /*
       * 상한에 걸린 뒤에도 캐시가 있으면 그대로 쓴다. 형식(SCHEMA)이 옛것이어도
       * 버리지 않는다 — 버리면 배포본의 게임 수가 오히려 줄어들기 때문이다.
       * SCHEMA를 올린 날 CI는 3000개를 전부 "만료"로 보는데, 상한이 1200이라
       * 나머지 1800개를 버리면 사이트가 1200개로 쪼그라든다.
       * 옛 캐시라도 대부분의 필드는 그대로 쓸 수 있고, 다음 회차에 갱신된다.
       */
      return await readJson(path.join(CACHE, `${id}.json`));
    }
    try {
      const { detail, cached } = await fetchDetail(id, { ttlHours });
      if (!cached) {
        fetched++;
        consecutive429 = 0;
        if (fetched >= MAX_NEW) {
          stop = true;
          console.log(`[details] 이번 실행 상한(${MAX_NEW}개)에 도달. 나머지는 다음 실행에서 받는다.`);
        }
      }
      return detail;
    } catch (err) {
      failed++;
      if (/429/.test(err.message)) {
        if (++consecutive429 >= 10) {
          stop = true;
          console.warn('[details] 429가 연속으로 나와 이번 실행은 여기서 멈춘다.');
        }
      }
      console.warn(`[details] ${id} 실패: ${err.message}`);
      return null;
    } finally {
      done++;
      if (done % 50 === 0 || done === ids.length) {
        console.log(`[details] ${done}/${ids.length} (신규 ${fetched}, 실패 ${failed})`);
      }
    }
  });

  console.log(
    `[details] 완료 · 신규 ${fetched} · 실패 ${failed}` + (skipped ? ` · 건너뜀 ${skipped}` : '')
  );
  return results.filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ranks = await readJson(path.join(ROOT, 'data', 'ranks.json'));
  if (!ranks) throw new Error('먼저 sync-ranks.mjs를 실행하세요.');
  const limit = Number(process.env.LIMIT || DEFAULT_LIMIT);
  const ids = ranks.games.slice(0, limit).map((g) => g.id);

  /*
   * 순위와 상관없이 꼭 받아야 하는 게임(data/extra-games.json).
   *
   * BGG는 평가 30개 이상인 게임에만 순위를 매기므로, 국내에서만 팔리는
   * 교육용 게임은 랭킹 덤프에 아예 없다. LIMIT을 올려도 들어오지 않는다.
   * 앞쪽에 붙여 수집 상한에 걸려 밀리지 않게 한다.
   */
  const extra = (await readJson(path.join(ROOT, 'data', 'extra-games.json'), {}))?.ids ?? [];
  const known = new Set(ids);
  const extraIds = extra.map(Number).filter((id) => Number.isFinite(id) && !known.has(id));
  if (extraIds.length) console.log(`[details] 순위 밖 지정 게임 ${extraIds.length}개 포함`);
  ids.unshift(...extraIds);
  await syncDetails(ids, {
    concurrency: Number(process.env.CONCURRENCY || 2),
    /*
     * 기본 14일.
     *
     * 예전엔 20시간이었는데, 그러면 매일 도는 CI가 매번 전량을 다시 받는다.
     * 1만 개에서는 그 자체로 429를 부른다. 매일 바뀌는 값(순위·평점·평가 수)은
     * 애초에 랭킹 덤프에서 오고, 여기서 받는 값(난이도·인원·메커니즘)은
     * 거의 변하지 않는다.
     *
     * 14일이면 하루 갱신분이 약 714개라, 실행당 상한(MAX_NEW 1200) 안에
     * 아직 못 받은 게임을 채울 여유가 남는다. 7일로 두면 갱신분만으로 상한을
     * 다 써버려서 미수집분이 영영 채워지지 않는다.
     * TTL_HOURS=0 으로 캐시를 무시하고 전부 새로 받을 수 있다.
     */
    ttlHours: process.env.TTL_HOURS != null ? Number(process.env.TTL_HOURS) : 336,
  });
}

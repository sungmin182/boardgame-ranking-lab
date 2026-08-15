/**
 * BGG 실시간 조회용 중계 서버 (Cloudflare Workers)
 *
 * 왜 필요한가
 *   api.geekdo.com 은 CORS 헤더(Access-Control-Allow-Origin)를 내려주지 않는다.
 *   그래서 브라우저에서 곧바로 fetch 하면 차단된다. 이 워커가 대신 호출해서
 *   CORS 헤더를 붙여 돌려준다. 그 이상은 아무것도 하지 않는다.
 *
 * 배포
 *   npx wrangler login
 *   npx wrangler deploy --config proxy/wrangler.toml
 *
 *   발급된 https://bgg-live-proxy.<계정>.workers.dev 주소를
 *   assets/config.js 의 LIVE_PROXY 에 적으면 실시간 새로고침이 켜진다.
 *
 *   ALLOWED_ORIGINS 에 실제 사이트 주소를 넣어야 한다. 목록에 없는 출처에서
 *   호출하면 브라우저가 응답을 버리므로, 사이트를 배포한 뒤 주소를 추가할 것.
 */

const ALLOWED_ORIGINS = [
  'http://localhost:4173',
  // 'https://<본인아이디>.github.io',
];

// 중계를 허용할 엔드포인트만 명시한다(열린 프록시가 되지 않도록)
const ROUTES = {
  '/dynamicinfo': (p) =>
    `https://api.geekdo.com/api/dynamicinfo?objectid=${p.objectid}&objecttype=thing`,
  '/geekitems': (p) =>
    `https://api.geekdo.com/api/geekitems?objectid=${p.objectid}&objecttype=thing&subtype=boardgame`,
};

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') ?? '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    const url = new URL(request.url);
    const build = ROUTES[url.pathname];
    if (!build) {
      return new Response(JSON.stringify({ error: 'unknown route' }), {
        status: 404,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const objectid = url.searchParams.get('objectid');
    if (!/^\d+$/.test(objectid ?? '')) {
      return new Response(JSON.stringify({ error: 'objectid must be numeric' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const upstream = await fetch(build({ objectid }), {
      headers: { 'User-Agent': 'BoardgameRankingLab/1.0 (personal site)' },
      // 같은 게임을 연달아 눌러도 BGG를 계속 때리지 않도록 5분 캐시
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
};

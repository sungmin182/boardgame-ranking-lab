/**
 * 사이트 설정.
 *
 * LIVE_PROXY
 *   BGG의 JSON 엔드포인트(api.geekdo.com)는 CORS 헤더를 주지 않기 때문에
 *   브라우저에서 직접 호출하면 차단됩니다. 그래서 "지금 이 순간 값"을 보려면
 *   아주 얇은 중계 서버가 하나 필요합니다.
 *
 *   proxy/worker.js 를 Cloudflare Workers에 배포한 뒤(무료, 1분 소요)
 *   발급된 주소를 여기에 넣으세요. 예:
 *     LIVE_PROXY: 'https://bgg-live.내계정.workers.dev'
 *
 *   비워두면 사이트는 매일 갱신되는 data/games.json 만으로 정상 동작하고,
 *   상세 패널의 '실시간 새로고침' 버튼만 숨겨집니다.
 */
window.LZ_CONFIG = {
  LIVE_PROXY: '',
  DATA_URL: 'data/games.json',
};

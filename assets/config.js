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
  LIVE_PROXY: 'https://bgg-live-proxy.boardgame-ranking-lab.workers.dev',
  DATA_URL: 'data/games.json',

  /**
   * 상세 패널의 "당근 검색" 버튼이 여는 주소. {q} 자리에 게임 이름이 들어갑니다.
   *
   * 휴대폰에 당근 앱이 깔려 있으면 이 https 주소가 앱으로 바로 열립니다
   * (앱링크/유니버설 링크). daangn:// 같은 커스텀 스킴을 쓰지 않는 이유는,
   * 앱이 없을 때 아무 일도 일어나지 않고 오류 화면만 남기 때문입니다.
   *
   * 당근이 검색 경로를 바꾸면 여기 한 줄만 고치면 됩니다.
   * 확인 방법: 휴대폰이나 PC에서 당근 중고거래 검색을 한 번 하고,
   * 주소창의 주소에서 검색어 자리를 {q} 로 바꿔 넣으세요.
   */
  DAANGN_SEARCH: 'https://www.daangn.com/kr/buy-sell/?search={q}',
};

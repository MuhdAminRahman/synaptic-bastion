
// ═══ STATE ═══
const S = {
  base: null,
  pollTimer: null,
  polling: false,
  nodeConfig: {},   // loaded from proxy GET /api/config/nodes
  metrics: {},      // node metrics cache
  metricsTs: {},    // metrics fetch timestamps
  metricsTimer: null, // auto-refresh interval when on Nodes page
  nodes: {},   // populated dynamically after connect from S.nodeConfig
  patroni: null, // Patroni cluster state
  outposts: [], // Outpost monitored targets
  hist:  {},   // populated per node after connect
  reqs:0, ok:0,
  testRes:{},
  chaosEvents:{}, // name -> { killedAt, recoveredAt }
};
const HIST = 30;

// ═══ CONFIG — all magic numbers in one place ═══
const CFG = {
  PROXY_HOST: '116.203.166.135', // Hetzner Floating IP — reassignable on failover
  PROXY_PORT:          8090,
  PROXY_PATH:          '/proxy', // Nginx proxies /proxy/* → localhost:9000/*
  APP_PORT:            8080,
  POLL_MS:             10000,
  POLL_TIMEOUT_MS:     7000,
  PROBE_TIMEOUT_MS:    7000,
  CONNECT_TIMEOUT_MS:  5000,
  CHAOS_TIMEOUT_MS:    15000,
  RESTORE_TIMEOUT_MS:  10000,
  LOADTEST_TIMEOUT_MS: 120000,
  LOG_MAX:             100,
  EVIDENCE_MAX:        20,
  TOAST_MS:            4200,
  LAT_GOOD_MS:         100,
  LAT_WARN_MS:         500,
  UPTIME_GOOD_PCT:     95,
  UPTIME_WARN_PCT:     75,
  RATE_GOOD_PCT:       95,
  RATE_WARN_PCT:       80,
  KILL_VERIFY_WAIT_MS: 500,
  RTO_POLL_MS:         500,
  RTO_MAX_POLLS:       40,
  RTO_ACCEPTABLE_MS:   8000,
  REPL_CHECK_TIMEOUT_MS: 12000,
  METRICS_TTL:         30000,
  AUTH_TOKEN: '<AUTH_TOKEN_HERE>',
  CHART_COLORS: ['#c8a84b','#4a7ab5','#cc2200','#8b7535','#f0d060','#6a8aa0'],
  CHART_TICK_COLOR: '#4a4020',
  TARGETS_SPEC: {
    RTO_MS:         5000,
    DETECT_MS:      5000,
    LAT_P50_MS:     180,
    LAT_P95_MS:     250,
    THROUGHPUT_RPS: 1000, // realistic for same-DC Tailscale mesh
    REPL_LAG_MS:    50,
    REPL_LAG_PEAK:  100,
    UPTIME_PCT:     99,
    DB_FAILOVER_MS: 30000, // Patroni election ceiling — observed real-world ~15-25s
  },
};
const TARGETS = CFG.TARGETS_SPEC;

// Dynamic node helpers — use these everywhere instead of CFG.NODES
function nodeNames(){ return Object.keys(S.nodeConfig); }
function nodeList(){ return Object.values(S.nodeConfig); }
function masterNode(){
  // Use Patroni leader if known, fallback to static db=master config
  if(S.patroni?.leader?.name){
    const n = nodeList().find(n=>n.name===S.patroni.leader.name);
    if(n) return n;
  }
  return nodeList().find(n=>n.db==='master')||nodeList()[0]||null;
}
// Alias for convenience
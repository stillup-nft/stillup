import { createPublicClient, createWalletClient, custom, http, defineChain,
         formatEther, getAddress, BaseError, ContractFunctionRevertedError } from "./vendor/viem.js";
import { CONFIG } from "./config.js";
import { ABI } from "./abi.js";

// ── 설정. 배포된 사이트에서는 컨트랙트와 체인을 고정하고, 로컬에서만 오버라이드를 허용한다.
const q = new URLSearchParams(location.search);
const isLocal = ["localhost", "127.0.0.1", "0.0.0.0"].includes(location.hostname);
const cfg = { ...CONFIG };
if (isLocal) {
  if (q.get("contract")) cfg.contract = q.get("contract");
  if (q.get("rpc")) cfg.rpc = q.get("rpc");
  if (q.get("chain")) cfg.chainId = Number(q.get("chain"));
}

const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: "Explorer", url: cfg.explorer } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc) });
const ZERO = "0x0000000000000000000000000000000000000000";
const deployed = () => cfg.contract && cfg.contract.toLowerCase() !== ZERO;

const $ = (id) => document.getElementById(id);
const eth = (wei, d = 4) => Number(formatEther(wei)).toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const read = (fn, args = [], blockNumber) =>
  pub.readContract({ address: cfg.contract, abi: ABI, functionName: fn, args, ...(blockNumber ? { blockNumber } : {}) });

// 가격 구간을 로컬에서 그대로 계산한다. 앞사람이 먼저 사서 구간이 넘어가도
// 거래가 죽지 않도록 여유분을 얹어 보내기 위해 필요하다 — 초과분은 컨트랙트가 돌려준다.
// 컨트랙트의 priceAt 과 동일해야 한다: 3장마다 0.001 ETH 씩
const TIER = 3n, P_START = 30000000000000000n, P_STEP = 1000000000000000n;
const priceAt = (sold) => P_START + P_STEP * (sold / TIER);
function quoteAt(sold, n) {
  let t = 0n;
  for (let i = 0n; i < n; i++) t += priceAt(sold + i);
  return t;
}
const SAFETY = 15n;   // 서명 직전에 최신값을 다시 읽으므로, 남은 창(시뮬레이션→체결)만 덮으면 된다

let walletClient = null, account = null, proof = null, proofFor = null, state = null;
let busy = false;        // 진짜 상태로 둔다. render 가 이걸 존중해야 전송 중 버튼이 다시 열리지 않는다
let wrongChain = false;
let rpcFails = 0;
let renderSeq = 0;
let listening = false;
let delegated = false;   // EIP-7702 로 위임된 EOA — onERC721Received 가 없으면 민팅이 영구히 실패한다

// ── 상태 읽기 ────────────────────────────────────────────────
async function load() {
  if (!deployed()) return null;
  // 모든 읽기를 한 블록에 고정한다 — 아니면 saleMinted 와 mintedBy 가 서로 다른 블록을 가리킬 수 있다.
  // getBlock 이 실패해도 페이지가 통째로 죽지는 않게, 고정 없이라도 읽어 나간다.
  let bn = undefined, chainNow = null;
  try {
    const blk = await pub.getBlock();
    bn = blk.number; chainNow = blk.timestamp;
  } catch { /* 아래에서 브라우저 시계로 대체한다 */ }
  const [saleMinted, saleMax, cap, alStart, pubStart, end, closed, revealed, mine,
         totalMinted, maxSupply] = await Promise.all([
    read("saleMinted", [], bn), read("SALE_MAX", [], bn), read("WALLET_CAP", [], bn),
    read("allowlistStart", [], bn), read("saleStart", [], bn), read("saleEnd", [], bn),
    read("supplyClosed", [], bn), read("startingIndexSet", [], bn),
    account ? read("mintedBy", [account], bn) : Promise.resolve(0n),
    read("totalMinted", [], bn), read("MAX_SUPPLY", [], bn),
  ]);
  // 체인 시각을 쓴다. 브라우저 시계가 빠르면 아직 안 열린 민팅 버튼이 열려 보이고,
  // 느리면 열린 민팅이 잠겨 보인다. 체인을 못 읽을 때만 시계로 대체한다.
  const now = chainNow ?? BigInt(Math.floor(Date.now() / 1000));
  const clockOnly = chainNow === null;
  let phase = "soon";
  if (closed) phase = "closed";
  else if (end !== 0n && now >= end) phase = "ended";
  else if (saleMinted >= saleMax || totalMinted >= maxSupply) phase = "soldout";
  else if (pubStart !== 0n && now >= pubStart) phase = "public";
  else if (alStart !== 0n && now >= alStart) phase = "allowlist";
  else if (alStart === 0n && pubStart === 0n) phase = "unset";
  // 회수(claimUnsold) 후에는 saleMinted 가 그대로 남아 있어 판매 재고가 남은 것처럼 보인다.
  // 실제로 살 수 있는 수량은 둘 중 작은 쪽이다.
  const left = (a, b) => (a < b ? a : b);
  const available = left(saleMax - saleMinted, maxSupply - totalMinted);
  return { saleMinted, saleMax, cap, alStart, pubStart, end, closed, revealed, mine,
           totalMinted, maxSupply, available, phase, now, clockOnly };
}

// ── 알로우리스트 증명 ─────────────────────────────────────────
async function fetchProof(addr) {
  try {
    // 문서가 아니라 이 모듈을 기준으로 푼다 — index.html 이 어느 깊이에 있든 같은 곳을 가리킨다
    const url = new URL(cfg.proofBase + addr.toLowerCase() + ".json", import.meta.url);
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.proof) ? j.proof : null;
  } catch { return null; }
}

// ── 지갑 ────────────────────────────────────────────────────
async function connect() {
  const p = window.ethereum;
  if (!p) return say("지갑이 없습니다. 브라우저 지갑을 설치한 뒤 다시 시도해 주세요.", true);
  try {
    // 리스너를 먼저 건다 — 체인 전환이 거절돼도 이후 수동 전환을 감지할 수 있어야 한다
    if (!listening) {
      listening = true;
      p.on?.("accountsChanged", () => location.reload());
      p.on?.("chainChanged", () => location.reload());
    }
    const [a] = await p.request({ method: "eth_requestAccounts" });
    const next = getAddress(a);
    if (next !== account) { proof = null; proofFor = null; }   // 이전 계정의 증명이 새 계정에 붙지 않게
    account = next;
    walletClient = createWalletClient({ account, chain, transport: custom(p) });

    const cur = await p.request({ method: "eth_chainId" });
    wrongChain = parseInt(cur, 16) !== cfg.chainId;
    if (wrongChain) {
      try { await switchChain(p); wrongChain = false; }
      catch (e) { say(friendly(e), true); }                    // 전환 실패는 삼키고, 아래에서 증명은 받아 둔다
    }
    if (proofFor !== account) { proof = await fetchProof(account); proofFor = account; }
    // 위임된 계정이면 _safeMint 가 빈 데이터로 리버트한다. 미리 알아내야 이유를 말해 줄 수 있다.
    try {
      const code = await pub.getCode({ address: account });
      delegated = !!code && code.toLowerCase().startsWith("0xef0100");
      if (delegated) say("이 지갑은 스마트 계정으로 위임되어 있습니다. 민팅이 실패할 수 있습니다.", true);
    } catch { delegated = false; }
    await render();
  } catch (e) { say(friendly(e), true); await render(); }
}

async function switchChain(p) {
  const hex = "0x" + cfg.chainId.toString(16);
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code === 4902) {
      await p.request({ method: "wallet_addEthereumChain", params: [{
        chainId: hex, chainName: cfg.chainName,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [cfg.rpc], blockExplorerUrls: [cfg.explorer],
      }]});
    } else throw e;
  }
}

// ── 민팅 ────────────────────────────────────────────────────
function readQty() {
  const el = $("mintQty"); if (!el) return null;
  const raw = String(el.value ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;      // 2.5, -1, 1e3, 빈칸, 공백 모두 여기서 걸린다
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

async function doMint(n) {
  if (busy) return;                          // 전송 중 두 번째 클릭을 막는다
  if (!walletClient || !account) return connect();
  if (wrongChain) return switchOrTell();
  if (!Number.isSafeInteger(n) || n < 1) return say("수량을 확인해 주세요.", true);
  const s = state;
  if (!s || (s.phase !== "public" && s.phase !== "allowlist")) return;
  const useAL = s.phase === "allowlist";
  if (useAL && !proof) return say("이 주소는 알로우리스트에 없습니다. 퍼블릭 시작을 기다려 주세요.", true);

  try {
    setBusy(true);
    // 구간이 3장뿐이라 화면 값은 금방 낡는다. 서명 직전에 최신 블록으로 다시 읽어
    // 낡은 값에서 출발하지 않게 한 뒤, 그 위에 여유분을 얹는다. 초과분은 컨트랙트가 돌려준다.
    const qn = BigInt(n);
    let sold = s.saleMinted;
    try { sold = await read("saleMinted"); } catch { /* 못 읽으면 화면 값으로 간다 */ }
    const value = quoteAt(sold + SAFETY, qn);
    const { request } = await pub.simulateContract({
      address: cfg.contract, abi: ABI, account,
      functionName: useAL ? "mintAllowlist" : "mint",
      args: useAL ? [qn, proof] : [qn],
      value,
    });
    const hash = await walletClient.writeContract(request);
    say(`전송됨 · ${short(hash)} · 확인을 기다리는 중`);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status === "success") {
      say(`${n}장 민팅 완료.`, false, `${cfg.explorer}/tx/${hash}`);
    } else say(await whyReverted(request, rc), true);
    await render();
  } catch (e) { say(friendly(e), true); }
  finally { setBusy(false); }
}

/// 시뮬레이션을 통과한 뒤 체인 위에서 되돌아간 경우 — 여기서 다시 불러 봐야 이유를 알 수 있다
async function whyReverted(request, rc) {
  try {
    await pub.call({ ...request, blockNumber: rc.blockNumber });
    return "거래가 실패했습니다.";
  } catch (e) { return friendly(e); }
}

// ── 에러를 사람 말로 ─────────────────────────────────────────
const ERRORS = {
  NotStarted: "아직 시작 전입니다.",
  Ended: "민팅 창이 끝났습니다.",
  SoldOut: "남은 물량이 없습니다.",
  WalletCapExceeded: "지갑당 3장까지입니다.",
  WrongPayment: "보낸 금액이 부족합니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
  BadProof: "알로우리스트 증명이 올바르지 않습니다.",
  SupplyIsClosed: "물량이 봉인되었습니다.",
  ZeroQuantity: "수량을 확인해 주세요.",
  // 아래는 민팅 경로에서는 나오지 않지만, 해독 못 해서 뭉뚱그리는 것보다는 낫다
  NotArmed: "아직 리빌이 예약되지 않았습니다.",
  TooEarly: "아직 이릅니다.",
  Stale: "예약 블록이 만료되었습니다. 다시 예약해야 합니다.",
  Frozen: "메타데이터가 고정되었습니다.",
  WindowLocked: "판매 일정은 시작 후 되돌릴 수 없습니다.",
  Disabled: "사용할 수 없는 기능입니다.",
  BadAddress: "주소가 올바르지 않습니다.",
};
function friendly(e) {
  if (e?.code === 4001 || /User rejected|denied/i.test(e?.message || "")) return "지갑에서 거절되었습니다.";
  if (delegated) return "이 지갑은 스마트 계정으로 위임되어 있어 NFT 를 받지 못합니다. 다른 지갑으로 시도해 주세요.";
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = rev?.data?.errorName;
    if (name && ERRORS[name]) return ERRORS[name];
    if (/insufficient funds/i.test(e.message)) return "잔액이 부족합니다.";
  }
  return "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

// ── 화면 ────────────────────────────────────────────────────
function say(text, bad = false, link = null) {
  const el = $("mintMsg"); if (!el) return;
  el.textContent = text;                       // innerHTML 싱크를 두지 않는다
  if (link) {
    el.appendChild(document.createTextNode(" "));
    const a = document.createElement("a");
    a.href = link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "거래 보기";
    el.appendChild(a);
  }
  el.className = "mintmsg" + (bad ? " bad" : "");
}
function setBusy(b) {
  busy = b;
  const el = $("mintBtn");
  if (el) { el.disabled = b || el.disabled; el.setAttribute("aria-busy", b ? "true" : "false"); }
}
async function switchOrTell() {
  try { await switchChain(window.ethereum); wrongChain = false; await render(); }
  catch (e) { say(friendly(e), true); }
}

const PHASE_TEXT = {
  unset: ["민팅 일정 공지 예정", "시작 전"],
  soon: ["민팅 시작 전", "시작 전"],
  allowlist: ["알로우리스트 우선", "민팅"],
  public: ["퍼블릭 민팅 중", "민팅"],
  soldout: ["완판", "완판"],
  ended: ["민팅 창 종료", "종료됨"],
  closed: ["물량 봉인 완료", "봉인됨"],
};

async function render() {
  const box = $("mintLive"); if (!box) return;
  const btn = $("mintBtn");
  if (!deployed()) {                             // 배포 전: 정적 안내를 두되 버튼은 잠근다
    if (btn) btn.disabled = true;
    return;
  }
  const seq = ++renderSeq;
  try {
    const next = await load();
    if (seq !== renderSeq) return;               // 늦게 끝난 렌더가 최신 화면을 덮어쓰지 않게
    state = next;
    rpcFails = 0;
  } catch {
    if (seq !== renderSeq) return;
    rpcFails++;
    $("mintState").textContent = "네트워크 상태를 확인하는 중";
    if (rpcFails >= 2) say("네트워크가 불안정합니다. 화면의 숫자가 최신이 아닐 수 있습니다.", true);
    if (btn) btn.disabled = true;
    return;
  }
  const s = state; if (!s) return;

  const [label, btnText] = PHASE_TEXT[s.phase] || PHASE_TEXT.unset;
  // 체인 시각을 못 읽어 브라우저 시계로 판정한 경우 — 단계 표시가 틀릴 수 있다
  $("mintState").textContent = s.clockOnly ? label + " (시각 확인 중)" : label;
  const left = s.available;
  $("mintProgress").textContent = `${s.saleMax - left} / ${s.saleMax} · 남은 ${left}`;
  const bar = $("mintBar"); if (bar) bar.style.width = `${Number(s.saleMinted * 100n / s.saleMax)}%`;

  const qty = $("mintQty");
  if (qty) {
    const room = Math.max(0, Math.min(Number(s.cap - s.mine), Number(left)));
    qty.max = String(room);
    if (readQty() !== null && readQty() > room) qty.value = String(room || 1);
  }
  const n = readQty();
  const canMint = (s.phase === "public" || s.phase === "allowlist")
                  && left > 0n && s.mine < s.cap && n !== null && n >= 1;

  if (btn) {
    if (!account)        { btn.textContent = "지갑 연결"; btn.disabled = false; }
    else if (wrongChain) { btn.textContent = `${cfg.chainName} 로 전환`; btn.disabled = false; }
    else                 { btn.textContent = btnText; btn.disabled = !canMint; }
    if (busy) btn.disabled = true;               // 전송 중에는 무엇도 버튼을 열지 못한다
  }

  if (account && n !== null && left > 0n) {
    $("mintCost").textContent = `${eth(quoteAt(s.saleMinted, BigInt(n)))} ETH`;
  } else $("mintCost").textContent = "—";

  const who = $("mintWho");
  if (who) {
    if (!account) who.textContent = "";
    else if (wrongChain) who.textContent = `${short(account)} · ${cfg.chainName} 가 아닙니다`;
    else who.textContent = `${short(account)} · 보유 ${s.mine}/${s.cap}`
      + (s.phase === "allowlist" ? (proof ? " · 알로우리스트 ✓" : " · 알로우리스트 아님") : "");
  }
}

// ── 시작 ────────────────────────────────────────────────────
function boot() {
  const btn = $("mintBtn");
  if (btn) btn.addEventListener("click", () => {
    if (busy) return;
    if (!account) return connect();
    if (wrongChain) return switchOrTell();
    const n = readQty();
    if (n === null) return say("수량은 1 이상의 정수여야 합니다.", true);
    doMint(n);
  });
  let t = null;
  $("mintQty")?.addEventListener("input", () => {      // 키 입력마다 RPC 를 때리지 않는다
    clearTimeout(t); t = setTimeout(render, 250);
  });
  render();
  setInterval(() => { if (deployed()) render(); }, 15000);
}
document.readyState === "loading" ? addEventListener("DOMContentLoaded", boot) : boot();

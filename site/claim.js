// GODLET holder-rewards claim widget — viem + wagmi, no backend, no keys.
// Verified on-chain (Nov 10 2026) against the rewards contract bytecode + eth_call:
//   claim()            0x4e71d92d  -> returns (uint256 godlet, uint256 whype), pays both to msg.sender
//   earned(address)    0x008cc262  -> pending GODLET (matches claim() return[0])
//   earnedPaired(addr) 0xa0f35c73  -> pending WHYPE  (matches claim() return[1])
//   token()            -> GODLET, pairedAsset() -> WHYPE
//   setClaimOperator(address,bool) 0x020a7515 only authorises a third party to claimFor(you); not needed before claim().
import {
  defineChain, createPublicClient, http, fallback, parseAbi, formatUnits, encodeFunctionData, decodeFunctionResult,
} from 'https://esm.sh/viem@2.21.55';
import {
  createConfig, injected, connect, disconnect, getAccount, watchAccount, switchChain,
  writeContract, waitForTransactionReceipt, getBalance, reconnect,
} from 'https://esm.sh/@wagmi/core@2.16.3?deps=viem@2.21.55';

const CHAIN_ID = 99901;                      // 0x1863d
const RPCS = ['https://rpc.elysium.kinetiq.xyz', 'https://rpc-elysium-mainnet.t.conduit.xyz'];
const REWARDS = '0x17A7DF2918B08ABa87e44D0dFdEb6c5B603C5155';
const GODLET = '0x383c746dcfc2b623be73dbc2e4c4f2c3d68d7ba3';
const WHYPE = '0xba876237b0f021a6c6d852d6c26e107997cc5e81';
const EXPLORER = 'https://elyscan.live';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const elysium = defineChain({
  id: CHAIN_ID, name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcUrls: { default: { http: RPCS } },
  blockExplorers: { default: { name: 'Elyscan', url: EXPLORER } },
});
const abi = parseAbi([
  'function claim() returns (uint256, uint256)',
  'function earned(address) view returns (uint256)',
  'function earnedPaired(address) view returns (uint256)',
]);

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('cl-status'), addr: $('cl-addr'), net: $('cl-net'),
  god: $('cl-godlet'), why: $('cl-whype'), earned: $('cl-earned'),
  connect: $('cl-connect'), claim: $('cl-claim'), msg: $('cl-msg'),
  lookup: $('cl-lookup'), lookupBtn: $('cl-lookup-btn'),
};
const say = (t, kind = '') => { ui.msg.innerHTML = t; ui.msg.className = 'cl-msg ' + kind; };
const fmt = (v, d = 4) => {
  const s = formatUnits(v, 18); const [i, f = ''] = s.split('.');
  if (v === 0n) return '0';
  const n = Number(s);
  if (n >= 1) return Number(i).toLocaleString('en-US') + (f ? '.' + f.slice(0, d) : '');
  return n.toPrecision(4);
};

// --- 1. preflight: keep only RPCs that answer eth_chainId == 0x1863d -------------------
async function goodRpcs() {
  const ok = [];
  await Promise.all(RPCS.map(async (u) => {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      const j = await r.json();
      if (j.result && parseInt(j.result, 16) === CHAIN_ID) ok.push(u);
    } catch (_) {}
  }));
  return RPCS.filter((u) => ok.includes(u));   // keep priority order
}

let pc, config, viewAddr = null, busy = false;

// --- 2. claimable: eth_simulateV1(traceTransfers) -> Transfer logs; fallback eth_call claim() -----
async function claimable(user) {
  const u = user.toLowerCase();
  try {
    const res = await pc.request({
      method: 'eth_simulateV1',
      params: [{ blockStateCalls: [{ calls: [{ from: user, to: REWARDS, data: '0x4e71d92d' }] }],
        traceTransfers: true, validation: false }, 'latest'],
    });
    const call = res[0].calls[0];
    if (call.status !== '0x1') throw new Error('simulated claim reverted');
    let g = 0n, w = 0n;
    for (const l of call.logs || []) {
      if (l.topics[0] !== TRANSFER || !l.topics[2] || ('0x' + l.topics[2].slice(26)).toLowerCase() !== u) continue;
      const a = l.address.toLowerCase();
      if (a === GODLET) g += BigInt(l.data);
      if (a === WHYPE) w += BigInt(l.data);
    }
    return { g, w, via: 'eth_simulateV1' };
  } catch (e) {
    // fallback: eth_call claim() — verified to return (godlet, whype)
    try {
      const data = await pc.call({ account: user, to: REWARDS, data: encodeFunctionData({ abi, functionName: 'claim' }) });
      const [g, w] = decodeFunctionResult({ abi, functionName: 'claim', data: data.data });
      return { g, w, via: 'eth_call' };
    } catch (_) {
      return null;   // claim() reverts (e.g. nothing accrued) -> caller falls back to earned()/earnedPaired()
    }
  }
}

async function refresh() {
  if (!viewAddr || !pc) return;
  try {
    let [c, e, ep] = await Promise.all([
      claimable(viewAddr),
      pc.readContract({ address: REWARDS, abi, functionName: 'earned', args: [viewAddr] }),
      pc.readContract({ address: REWARDS, abi, functionName: 'earnedPaired', args: [viewAddr] }),
    ]);
    if (!c) c = { g: e, w: ep, via: 'earned()' };
    ui.god.textContent = fmt(c.g);
    ui.why.textContent = fmt(c.w, 8);
    ui.earned.textContent = `earned(): ${fmt(e)} GODLET · earnedPaired(): ${fmt(ep, 8)} WHYPE · via ${c.via}`;
    ui.claim.dataset.empty = (c.g === 0n && c.w === 0n) ? '1' : '';
    syncButtons();
    if (ui.claim.dataset.empty && isOwnView()) say('Nothing to claim yet — rewards stream in as $GODLET trades.', 'warn');
  } catch (err) {
    say('Could not read rewards: ' + (err.shortMessage || err.message), 'err');
  }
}

const isOwnView = () => { const a = getAccount(config); return a.address && viewAddr && a.address.toLowerCase() === viewAddr.toLowerCase(); };

function syncButtons() {
  const a = getAccount(config);
  ui.connect.textContent = a.isConnected ? 'Disconnect' : 'Connect wallet';
  ui.addr.textContent = a.address ? a.address.slice(0, 6) + '…' + a.address.slice(-4) : 'not connected';
  const wrong = a.isConnected && a.chainId !== CHAIN_ID;
  ui.net.textContent = !a.isConnected ? '—' : wrong ? `wrong network (${a.chainId})` : 'Elysium ✓';
  ui.net.className = wrong ? 'bad' : (a.isConnected ? 'good' : '');
  if (!a.isConnected) { ui.claim.textContent = 'Connect to claim'; ui.claim.disabled = true; return; }
  if (wrong) { ui.claim.textContent = 'Switch to Elysium'; ui.claim.disabled = busy; return; }
  ui.claim.textContent = busy ? 'Claiming…' : 'Claim blessings';
  ui.claim.disabled = busy || !!ui.claim.dataset.empty || !isOwnView();
}

async function onClaim() {
  const a = getAccount(config);
  if (!a.isConnected) return;
  if (a.chainId !== CHAIN_ID) {
    try { await switchChain(config, { chainId: CHAIN_ID }); say('Switched to Elysium.', 'ok'); }
    catch (e) { say('Network switch rejected. Switch your wallet to Elysium (chainId 99901).', 'err'); }
    return syncButtons();
  }
  busy = true; syncButtons();
  try {
    // gas check: need HYPE for gas
    const [bal, gas, gasPrice] = await Promise.all([
      getBalance(config, { address: a.address, chainId: CHAIN_ID }),
      pc.estimateGas({ account: a.address, to: REWARDS, data: '0x4e71d92d' }),
      pc.getGasPrice(),
    ]);
    if (bal.value === 0n || bal.value < gas * gasPrice) {
      throw Object.assign(new Error('nohype'), { code: 'NOHYPE' });
    }
    const { g, w } = await claimable(a.address);
    if (g === 0n && w === 0n) throw Object.assign(new Error('nothing'), { code: 'NOTHING' });
    say('Confirm the claim in your wallet…');
    const hash = await writeContract(config, { address: REWARDS, abi, functionName: 'claim', chainId: CHAIN_ID });
    const link = `<a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 10)}…</a>`;
    say(`Pending: ${link}`);
    const rc = await waitForTransactionReceipt(config, { hash, chainId: CHAIN_ID });
    if (rc.status === 'success') say(`Blessings received ✓ ${link}`, 'ok');
    else say(`Transaction reverted: ${link}`, 'err');
    await refresh();                         // re-read right after the claim block
  } catch (e) {
    if (e.code === 'NOHYPE') say('Not enough HYPE on Elysium for gas. Bridge some HYPE first.', 'err');
    else if (e.code === 'NOTHING') say('Nothing to claim yet.', 'warn');
    else if (/reject|denied/i.test(e.shortMessage || e.message)) say('Transaction rejected in wallet.', 'warn');
    else say('Claim failed: ' + (e.shortMessage || e.message), 'err');
  } finally { busy = false; syncButtons(); }
}

async function init() {
  const rpcs = await goodRpcs();
  if (!rpcs.length) { ui.status.textContent = 'RPC offline'; say('Elysium RPC unreachable or wrong chainId. Try again later.', 'err'); return; }
  const transport = fallback(rpcs.map((u) => http(u)));
  pc = createPublicClient({ chain: elysium, transport });
  config = createConfig({ chains: [elysium], connectors: [injected()], transports: { [CHAIN_ID]: transport } });
  ui.status.textContent = 'live';
  await reconnect(config).catch(() => {});
  watchAccount(config, { onChange(acc) { if (acc.address) { viewAddr = acc.address; refresh(); } syncButtons(); } });
  const acc = getAccount(config); if (acc.address) viewAddr = acc.address;
  ui.connect.onclick = async () => {
    const a = getAccount(config);
    if (a.isConnected) { await disconnect(config); return syncButtons(); }
    if (!window.ethereum) { say('No browser wallet found. Install MetaMask, Rabby or another EVM wallet.', 'err'); return; }
    try { await connect(config, { connector: injected(), chainId: CHAIN_ID }); }
    catch (e) {
      try { await connect(config, { connector: injected() }); } catch (e2) { say('Connection rejected.', 'warn'); }
    }
    syncButtons();
  };
  ui.claim.onclick = onClaim;
  ui.lookupBtn.onclick = () => {
    const v = ui.lookup.value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return say('Enter a valid 0x address.', 'warn');
    viewAddr = v; say('Showing rewards for ' + v.slice(0, 6) + '…' + v.slice(-4)); refresh();
  };
  syncButtons(); refresh();
  setInterval(refresh, 30000);
}
init();

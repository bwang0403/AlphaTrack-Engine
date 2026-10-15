import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api, type AuthState, type MarketSnapshot, type Order, type Portfolio, type SystemStatus } from "./api";
import { PriceChart } from "./Chart";

type View = "terminal" | "portfolio" | "orders" | "system";
type OrderReplay = { id: string; symbol: string; side: "BUY" | "SELL"; quantity: number; idempotencyKey: string };
const PERIODS = ["5d", "1mo", "3mo", "6mo", "1y"];
const WATCHLIST = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "SPY", "QQQ"];
const NAV: { view: View; label: string; icon: string; key: string }[] = [
  { view: "terminal", label: "Terminal", icon: "⌁", key: "1" },
  { view: "portfolio", label: "Portfolio & Ledger", icon: "◫", key: "2" },
  { view: "orders", label: "Orders & Idempotency", icon: "↗", key: "3" },
  { view: "system", label: "System & Telemetry", icon: "◎", key: "4" }
];

function viewFromHash(): View {
  const route = window.location.hash.replace(/^#\/?/, "");
  return NAV.find(item => item.view === route)?.view ?? "terminal";
}
function cents(value: number) { return `$${(value / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function time(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function errorText(error: unknown) { return error instanceof ApiClientError ? `${error.message}${error.requestId ? ` · Request ${error.requestId}` : ""}` : error instanceof Error ? error.message : "Unexpected request failure"; }
function statusClass(status: Order["status"]) { return `order-status ${status.toLowerCase()}`; }

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [symbol, setSymbol] = useState("NVDA");
  const [search, setSearch] = useState("NVDA");
  const [period, setPeriod] = useState("1mo");
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [quotes, setQuotes] = useState<Record<string, MarketSnapshot>>({});
  const [health, setHealth] = useState<{ status: string; environment: string; timestamp: string } | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const [replays, setReplays] = useState<Record<string, OrderReplay>>({});
  const [dock, setDock] = useState<"orders" | "positions">("orders");
  const orderLock = useRef(false);

  const navigate = useCallback((next: View) => { window.location.hash = `/${next}`; setView(next); }, []);
  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement)?.tagName ?? "")) return;
      const destination = NAV.find(item => item.key === event.key);
      if (destination) navigate(destination.view);
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    if (!NAV.some(item => window.location.hash === `#/${item.view}`)) window.location.hash = "/terminal";
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); };
  }, [navigate]);

  const loadMarket = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMarket(await api.market(symbol, period)); }
    catch (cause) { setMarket(null); setError(errorText(cause)); }
    finally { setLoading(false); }
  }, [symbol, period]);
  const refreshAccount = useCallback(async () => {
    try {
      const [nextPortfolio, nextOrders] = await Promise.all([api.portfolio(), api.orders()]);
      setPortfolio(nextPortfolio); setOrders(nextOrders.orders);
    } catch (cause) { setError(errorText(cause)); }
  }, []);
  const refreshSystem = useCallback(async () => {
    try {
      const [nextHealth, nextSystem] = await Promise.all([api.health(), api.system()]);
      setHealth(nextHealth); setSystem(nextSystem);
    } catch (cause) { setError(errorText(cause)); }
  }, []);
  useEffect(() => { void loadMarket(); }, [loadMarket]);
  useEffect(() => {
    api.me().then(setAuth).catch(cause => { if (!(cause instanceof ApiClientError && cause.status === 401)) setError(errorText(cause)); }).finally(() => setAuthLoading(false));
  }, []);
  useEffect(() => {
    if (!auth) return;
    void refreshAccount();
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      api.orders().then(result => setOrders(result.orders)).catch(cause => setError(errorText(cause)));
      if (ticks % 3 === 0) void refreshAccount();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [auth, refreshAccount]);
  useEffect(() => {
    if (!auth || view !== "system") return;
    void refreshSystem();
    const timer = window.setInterval(() => { void refreshSystem(); void loadMarket(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [auth, view, refreshSystem, loadMarket]);
  useEffect(() => {
    if (!auth || !portfolio) return;
    let active = true;
    const symbols = portfolio.positions.map(item => item.symbol);
    if (!symbols.length) { setQuotes({}); return; }
    Promise.allSettled(symbols.map(item => api.market(item, "5d"))).then(results => {
      if (!active) return;
      const next: Record<string, MarketSnapshot> = {};
      results.forEach((result, index) => { if (result.status === "fulfilled") next[symbols[index]] = result.value; });
      setQuotes(next);
    });
    return () => { active = false; };
  }, [auth, portfolio]);

  const valuation = useMemo(() => {
    if (!portfolio) return null;
    const costBasisCents = portfolio.positions.reduce((sum, item) => sum + item.averageCostCents * item.quantity, 0);
    const complete = portfolio.positions.every(item => Number.isFinite(quotes[item.symbol]?.price));
    const holdingsCents = complete ? portfolio.positions.reduce((sum, item) => sum + Math.round(quotes[item.symbol].price * 100) * item.quantity, 0) : null;
    return { costBasisCents, holdingsCents, equityCents: holdingsCents === null ? null : portfolio.cashCents + holdingsCents, unrealizedCents: holdingsCents === null ? null : holdingsCents - costBasisCents };
  }, [portfolio, quotes]);

  async function authenticate(action: "demo" | "register" | "login", username: string, passcode: string) {
    setError(null);
    try { setAuth(action === "demo" ? await api.demo() : action === "register" ? await api.register(username, passcode) : await api.login(username, passcode)); }
    catch (cause) { setError(errorText(cause)); }
  }
  async function signOut() {
    try { await api.logout(); setAuth(null); setPortfolio(null); setOrders([]); setQuotes({}); setSystem(null); setReplays({}); }
    catch (cause) { setError(errorText(cause)); }
  }
  function chooseSymbol(next: string) { setSearch(next); if (next !== symbol) setDraftKey(crypto.randomUUID()); setSymbol(next); navigate("terminal"); }
  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const next = search.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(next)) { setError("Enter a valid US equity symbol."); return; }
    chooseSymbol(next);
  }
  function editOrder(next: { side?: "BUY" | "SELL"; quantity?: number }) {
    if (next.side) setSide(next.side);
    if (next.quantity !== undefined) setQuantity(next.quantity);
    setDraftKey(crypto.randomUUID());
  }
  async function waitForOrder(id: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(resolve => window.setTimeout(resolve, 500));
      const result = await api.orders();
      setOrders(result.orders);
      const found = result.orders.find(item => item.id === id);
      if (found?.status === "FILLED" || found?.status === "REJECTED") return found;
    }
    return null;
  }
  async function sendOrder(payload: Omit<OrderReplay, "id">, isReplay = false) {
    if (orderLock.current) return;
    orderLock.current = true; setSubmitting(true); setOrderMessage(null); setError(null);
    try {
      const result = await api.submitOrder(payload);
      setReplays(previous => ({ ...previous, [result.order.id]: { ...payload, id: result.order.id } }));
      if (!isReplay) setDraftKey(crypto.randomUUID());
      setOrderMessage(result.replayed ? `REPLAY VERIFIED · Original order ${result.order.id.slice(0, 8)} returned; no duplicate order created.` : `ORDER ACCEPTED · ${result.order.status} · awaiting asynchronous fill.`);
      const terminal = await waitForOrder(result.order.id);
      if (terminal?.status === "FILLED") setOrderMessage(`${result.replayed ? "REPLAY VERIFIED · " : ""}FILLED @ ${cents(terminal.filledPriceCents ?? 0)} · order ${terminal.id.slice(0, 8)}.`);
      if (terminal?.status === "REJECTED") setOrderMessage(`REJECTED · ${terminal.rejectionReason ?? "Order validation failed"}`);
      await refreshAccount();
    } catch (cause) {
      if (!isReplay && cause instanceof ApiClientError && cause.status < 500) setDraftKey(crypto.randomUUID());
      setError(errorText(cause));
    } finally { orderLock.current = false; setSubmitting(false); }
  }
  function placeOrder(event: FormEvent) { event.preventDefault(); void sendOrder({ symbol, side, quantity, idempotencyKey: draftKey }); }
  function replayOrder(item: OrderReplay) { void sendOrder(item, true); }
  const lastReplay = Object.values(replays).at(-1);
  const position = portfolio?.positions.find(item => item.symbol === symbol);

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => navigate("terminal")}><span className="brand-mark">A</span><span>ALPHATRACK <em>PRO</em></span></button>
      <form className="search" onSubmit={submitSearch}><span>⌕</span><input value={search} onChange={event => setSearch(event.target.value.toUpperCase())} aria-label="Search ticker" maxLength={10}/><kbd>↵</kbd></form>
      <div className="topbar-right"><span className="feed-pill"><span className={`status-dot ${market ? "online" : "offline"}`}/>{market ? `IEX ${market.freshness}` : "FEED OFFLINE"}</span>{auth && <><div className="user-badge"><span className="status-dot online"/><span>{auth.user.username ?? "Demo User"}<small>AUTHENTICATED SESSION</small></span></div><button className="signout" onClick={() => void signOut()}>SIGN OUT</button></>}</div>
    </header>
    <aside className="sidebar"><div className="nav-caption">WORKSPACE <span>01—04</span></div><nav>{NAV.map(item => <button key={item.view} className={view === item.view ? "active" : ""} onClick={() => navigate(item.view)} title={`${item.label} · ${item.key}`}><span className="nav-icon">{item.icon}</span><span className="nav-label">{item.label}</span><kbd>{item.key}</kbd></button>)}</nav><div className="sidebar-spacer"/><div className="paper-badge"><span className="status-dot online"/><div><strong>PAPER ENVIRONMENT</strong><small>Simulated fills · no real money</small></div></div></aside>
    <div className="workspace"><div className="ticker-tape"><span className="tape-label">QUICK WATCHLIST</span>{WATCHLIST.map(item => <button key={item} className={item === symbol ? "active" : ""} onClick={() => chooseSymbol(item)}>{item}{item === symbol && <span>●</span>}</button>)}<span className="tape-end">ALPACA IEX / US EQUITIES</span></div>
      <main className={view === "terminal" && auth ? "terminal-main" : ""}>
        {error && <div className="alert"><strong>REQUEST FAILED</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
        {authLoading ? <div className="loading">CHECKING SIGN-IN…</div> : !auth ? <AuthView onAuthenticate={authenticate}/> : view === "terminal" ? <>
          <div className="desk-heading"><div><p className="eyebrow">TRADING WORKSTATION / LIVE MARKET</p><h1>{symbol}<span> / USD</span></h1></div><div className="quote">{market ? <><strong>${market.price.toFixed(2)}</strong><span className={market.change >= 0 ? "positive" : "negative"}>{market.change >= 0 ? "+" : ""}{market.change.toFixed(2)} / {market.changePercent.toFixed(2)}%</span></> : <strong>—</strong>}</div></div>
          <div className="desk-metrics"><Metric label="VERIFIED CASH" value={portfolio ? cents(portfolio.cashCents) : "—"} note="server ledger · integer cents"/><Metric label="TOTAL EQUITY" value={valuation?.equityCents === null || !valuation ? "—" : cents(valuation.equityCents)} note="cash + live holdings"/><Metric label="BUYING POWER" value={portfolio ? cents(portfolio.cashCents) : "—"} note="cash-only paper orders"/><Metric label="UNREALIZED P&L" value={valuation?.unrealizedCents === null || !valuation ? "—" : cents(valuation.unrealizedCents)} note="market value − cost basis" tone={valuation?.unrealizedCents ?? 0}/><Metric label="CONNECTION" value={market ? `IEX ${market.freshness}` : "OFFLINE"} note={auth.user.kind === "demo" ? "demo session active" : "registered session active"} good={market?.freshness === "LIVE"}/></div>
          <div className="terminal-grid"><section className="panel chart-panel"><div className="panel-head"><div><p className="eyebrow">MARKET / VERIFIED OHLCV</p><h2>{symbol} <span className="muted">PRICE & VOLUME</span></h2></div><div className="periods">{PERIODS.map(item => <button key={item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>{loading ? <div className="loading">CONTACTING MARKET DATA PROVIDER…</div> : market ? <PriceChart bars={market.bars}/> : <div className="empty-chart">Market feed unavailable · no synthetic fallback</div>}<div className="data-foot"><span>SOURCE: {market ? "ALPACA IEX" : "DISCONNECTED"}</span><span>FINITE OHLCV {market ? "VERIFIED" : "UNAVAILABLE"}</span><span>{market?.bars.length ?? 0} BARS</span><span>{market ? `${market.freshness} · AS OF ${time(market.asOf)}` : "OUTAGE"}</span></div></section>
            <form className="panel order-ticket" onSubmit={placeOrder}><div className="panel-head"><div><p className="eyebrow">PAPER ORDER</p><h2>Trade {symbol}</h2></div><span className="paper-tag">SIMULATED</span></div><div className="segmented"><button type="button" className={side === "BUY" ? "buy active" : ""} onClick={() => editOrder({ side: "BUY" })}>BUY</button><button type="button" className={side === "SELL" ? "sell active" : ""} onClick={() => editOrder({ side: "SELL" })}>SELL</button></div><div className="ticket-fields"><label>ORDER TYPE<input value="MARKET" disabled/></label><label>WHOLE SHARES<input type="number" min="1" max="100000" step="1" value={quantity} onChange={event => editOrder({ quantity: Number(event.target.value) })}/></label></div><div className="ticket-summary"><div><span>Estimated order value</span><strong>{market && Number.isInteger(quantity) && quantity > 0 ? cents(Math.round(market.price * 100) * quantity) : "—"}</strong></div><div><span>Raw estimated cents</span><strong>{market && Number.isInteger(quantity) && quantity > 0 ? (Math.round(market.price * 100) * quantity).toLocaleString() : "—"}</strong></div><div><span>Available cash</span><strong>{portfolio ? cents(portfolio.cashCents) : "—"}</strong></div><div><span>Current position</span><strong>{position?.quantity ?? 0} shares</strong></div></div><button className={`submit-order ${side.toLowerCase()}`} disabled={!market || submitting || !Number.isInteger(quantity) || quantity < 1}>{submitting ? "PROCESSING…" : `SUBMIT ${side} ORDER →`}</button><div className="key-preview"><span>IDEMPOTENCY KEY · NEXT ORDER</span><code>{draftKey}</code><small>Same key returns the original server order on replay.</small></div>{orderMessage && <p className="success-message">{orderMessage}</p>}</form></div>
          <section className="panel bottom-dock"><div className="dock-bar"><div className="dock-tabs"><button className={dock === "orders" ? "active" : ""} onClick={() => setDock("orders")}>RECENT ORDERS <span>{orders.length}</span></button><button className={dock === "positions" ? "active" : ""} onClick={() => setDock("positions")}>CURRENT POSITIONS <span>{portfolio?.positions.length ?? 0}</span></button></div><button className="ghost-button" disabled={!lastReplay || submitting} onClick={() => lastReplay && replayOrder(lastReplay)}>↻ REPLAY LAST ORDER KEY</button></div><div className="dock-content">{dock === "orders" ? <OrderTable orders={orders.slice(0, 5)} replays={replays} onReplay={replayOrder} submitting={submitting} compact/> : <HoldingsTable portfolio={portfolio} quotes={quotes} compact/>}</div></section>
        </> : view === "portfolio" ? <><PageHeading eyebrow="SERVER-AUTHORITATIVE ACCOUNT" title="Portfolio & Ledger" onRefresh={refreshAccount}/><div className="page-metrics"><Metric label="TOTAL EQUITY" value={valuation?.equityCents === null || !valuation ? "—" : cents(valuation.equityCents)}/><Metric label="AVAILABLE CASH" value={portfolio ? cents(portfolio.cashCents) : "—"}/><Metric label="UNREALIZED P&L" value={valuation?.unrealizedCents === null || !valuation ? "—" : cents(valuation.unrealizedCents)} tone={valuation?.unrealizedCents ?? 0}/><Metric label="REALIZED P&L" value="NOT EXPOSED" note="current API has no realized P&L field"/></div><div className="portfolio-grid"><section className="panel allocation-panel"><p className="eyebrow">PORTFOLIO ALLOCATION</p><h2>Cash vs. holdings</h2>{valuation?.holdingsCents !== null && valuation ? <><div className="allocation-track"><span style={{ width: `${Math.max(0, Math.min(100, portfolio!.cashCents / Math.max(1, valuation.equityCents!) * 100))}%` }}/></div><div className="allocation-key"><span><i className="cash-key"/> Cash {cents(portfolio!.cashCents)}</span><span><i className="holdings-key"/> Holdings {cents(valuation.holdingsCents)}</span></div></> : <p className="muted">Live allocation unavailable until every holding has a verified market quote.</p>}<p className="muted">Valuations use the latest available IEX quote. Orders settle against server-selected prices.</p></section><section className="panel ledger-panel"><p className="eyebrow">INTEGER-CENT LEDGER INSPECTOR</p><h2>Authoritative cash balance</h2><div className="ledger-value">{portfolio?.cashCents.toLocaleString() ?? "—"}<small>cash_cents</small></div><div className="ledger-usd">{portfolio ? cents(portfolio.cashCents) : "—"} formatted USD</div><div className="constraint-list"><span>CHECK (cash_cents &gt;= 0)</span><span>CHECK (shares &gt;= 0)</span><span>LEDGER VERSION v{portfolio?.version ?? "—"}</span></div></section></div><section className="panel table-panel"><div className="panel-head"><div><p className="eyebrow">SERVER-AUTHORITATIVE POSITIONS</p><h2>Holdings</h2></div></div><HoldingsTable portfolio={portfolio} quotes={quotes}/></section></> : view === "orders" ? <><PageHeading eyebrow="ASYNCHRONOUS EXECUTION" title="Orders & Idempotency" onRefresh={refreshAccount}/><div className="lifecycle"><span>PENDING</span><b>→</b><span>PROCESSING</span><b>→</b><span>FILLED / REJECTED</span><small>Queue and DLQ depth are separate telemetry, not order statuses.</small></div><section className="panel table-panel"><div className="panel-head"><div><p className="eyebrow">ACCOUNT-SCOPED ORDER LOG</p><h2>Execution history</h2></div><span className="muted">AUTO REFRESH / 10 SEC</span></div><OrderTable orders={orders} replays={replays} onReplay={replayOrder} submitting={submitting}/></section><p className="page-footnote">Idempotency keys are retained only for orders placed in this browser session. The current orders API does not expose historical keys; those orders cannot be replayed from this UI.</p></> : <SystemView health={health} system={system} market={market} onRefresh={refreshSystem}/>}
      </main></div>
  </div>;
}

function AuthView({ onAuthenticate }: { onAuthenticate: (action: "demo" | "register" | "login", username: string, passcode: string) => Promise<void> }) {
  const [username, setUsername] = useState(""); const [passcode, setPasscode] = useState(""); const [busy, setBusy] = useState(false); const [mode, setMode] = useState<"login" | "register">("login");
  async function submit(action: "demo" | "register" | "login") { if (busy) return; setBusy(true); try { await onAuthenticate(action, username, passcode); } finally { setBusy(false); } }
  return <section className="panel auth-panel"><p className="eyebrow">SECURE PAPER TRADING</p><h1>Sign in to AlphaTrack</h1><p>Open an instant demo account, or register a username to return to your own paper portfolio.</p><button className="demo-button" disabled={busy} onClick={() => void submit("demo")}>INSTANT DEMO ACCOUNT SIGN-IN →</button><div className="auth-divider">OR USE YOUR ACCOUNT</div><form onSubmit={event => { event.preventDefault(); void submit(mode); }}><label>USERNAME<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={32} required/></label><label>PASSCODE<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={passcode} onChange={event => setPasscode(event.target.value)} minLength={10} maxLength={128} required/></label><button className="submit-order buy" disabled={busy}>{mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}</button></form><button className="auth-switch" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Need an account? Register" : "Already registered? Sign in"}</button></section>;
}

function Metric({ label, value, note, good, tone }: { label: string; value: string; note?: string; good?: boolean; tone?: number }) { return <div className="panel metric"><p className="eyebrow">{label}</p><strong className={good || (tone !== undefined && tone > 0) ? "positive" : tone !== undefined && tone < 0 ? "negative" : ""}>{value}</strong>{note && <small>{note}</small>}</div>; }
function PageHeading({ eyebrow, title, onRefresh }: { eyebrow: string; title: string; onRefresh: () => void }) { return <section className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div><button className="ghost-button" onClick={onRefresh}>↻ REFRESH</button></section>; }

function HoldingsTable({ portfolio, quotes, compact = false }: { portfolio: Portfolio | null; quotes: Record<string, MarketSnapshot>; compact?: boolean }) {
  return <div className="table-scroll"><table className={compact ? "compact-table" : ""}><thead><tr><th>SYMBOL</th><th>SHARES</th><th>AVG COST / CENTS</th><th>MARKET PRICE</th><th>MARKET VALUE</th><th>UNREALIZED P&L</th></tr></thead><tbody>{portfolio?.positions.length ? portfolio.positions.map(item => { const quote = quotes[item.symbol]; const priceCents = quote ? Math.round(quote.price * 100) : null; const pnl = priceCents === null ? null : (priceCents - item.averageCostCents) * item.quantity; const percent = priceCents === null ? null : ((priceCents - item.averageCostCents) / item.averageCostCents) * 100; return <tr key={item.symbol}><td><strong>{item.symbol}</strong></td><td>{item.quantity}</td><td>{cents(item.averageCostCents)} <small>{item.averageCostCents.toLocaleString()}¢</small></td><td>{priceCents === null ? "—" : cents(priceCents)}</td><td>{priceCents === null ? "—" : cents(priceCents * item.quantity)}</td><td className={pnl === null ? "" : pnl >= 0 ? "positive" : "negative"}>{pnl === null ? "—" : `${cents(pnl)} (${percent!.toFixed(2)}%)`}</td></tr>; }) : <tr><td colSpan={6} className="empty-row">No open positions yet.</td></tr>}</tbody></table></div>;
}

function OrderTable({ orders, replays, onReplay, submitting, compact = false }: { orders: Order[]; replays: Record<string, OrderReplay>; onReplay: (item: OrderReplay) => void; submitting: boolean; compact?: boolean }) {
  return <div className="table-scroll"><table className={compact ? "compact-table" : ""}><thead><tr><th>ORDER / TIME</th><th>SYMBOL</th><th>SIDE / QTY</th><th>STATE</th><th>FILL / CENTS</th><th>IDEMPOTENCY KEY</th><th>ACTION</th></tr></thead><tbody>{orders.length ? orders.map(order => <tr key={order.id}><td><strong>{order.id.slice(0, 8)}</strong><small>{time(order.requestedAt)} · updated {time(order.updatedAt)}</small></td><td><strong>{order.symbol}</strong></td><td className={order.side === "BUY" ? "positive" : "negative"}>{order.side} {order.quantity}</td><td><span className={statusClass(order.status)}>{order.status}</span>{order.rejectionReason && <small>{order.rejectionReason}</small>}</td><td>{order.filledPriceCents === null ? "—" : <>{cents(order.filledPriceCents)}<small>{order.filledPriceCents.toLocaleString()}¢</small></>}</td><td className="key-cell">{replays[order.id] ? <code title={replays[order.id].idempotencyKey}>{replays[order.id].idempotencyKey}</code> : <span className="muted">NOT RETURNED BY API</span>}</td><td><button className="replay-button" disabled={!replays[order.id] || submitting} onClick={() => onReplay(replays[order.id])}>↻ REPLAY</button></td></tr>) : <tr><td colSpan={7} className="empty-row">No orders yet. Submit a paper trade from Terminal.</td></tr>}</tbody></table></div>;
}

function SystemView({ health, system, market, onRefresh }: { health: { status: string; environment: string; timestamp: string } | null; system: SystemStatus | null; market: MarketSnapshot | null; onRefresh: () => void }) {
  return <><PageHeading eyebrow="CLOUD-NATIVE OPERATIONS" title="System health" onRefresh={onRefresh}/><div className="page-metrics"><Metric label="API / D1" value={health?.status === "ok" && system?.database === "ok" ? "ONLINE" : "CHECKING"} good={health?.status === "ok" && system?.database === "ok"}/><Metric label="SIGNED-IN USER" value={system?.session.kind.toUpperCase() ?? "CHECKING"} good={system?.session.authenticated}/><Metric label="MARKET FEED" value={market?.feed.toUpperCase() ?? "UNAVAILABLE"} good={Boolean(market)}/><Metric label="DATA FRESHNESS" value={market?.freshness ?? "UNAVAILABLE"} good={market?.freshness === "LIVE"}/></div><section className="panel architecture-panel"><p className="eyebrow">LIVE PIPELINE ARCHITECTURE</p><div className="architecture-flow">{["REACT CLIENT", "WORKER / RATE LIMIT", "AUTH / PEPPERED HASH", "D1 ORDER STATE", "CLOUDFLARE QUEUE", "D1 LEDGER TX"].map((step, index) => <div key={step} className="architecture-step"><small>0{index + 1}</small><strong>{step}</strong></div>)}</div><p className="muted">Queue configured: {system?.queue.configured ? "YES" : "NO / UNAVAILABLE"} · Queue depth: {system?.queue.depth ?? "not exposed"} · DLQ depth: {system?.queue.dlqDepth ?? "not exposed"}</p></section><div className="system-grid"><section className="panel system-copy"><p className="eyebrow">LIVE D1 ORDER STATES · YOUR ACCOUNT</p><h2>Order pipeline</h2><div className="state-grid">{(["PENDING", "PROCESSING", "FILLED", "REJECTED"] as const).map(status => <div key={status}><span>{status}</span><strong>{system ? system.orderCounts[status] : "—"}</strong></div>)}</div><p>Observed {system ? time(system.observedAt) : "—"}</p></section><section className="panel system-copy"><p className="eyebrow">AUTHENTICATION AND RATE LIMITS</p><h2>Runtime policy</h2><ul><li>256-bit HttpOnly session cookie · server-side peppered SHA-256</li><li>Scoped user ID: {system?.session.userId.slice(0, 8) ?? "—"} · {system?.session.kind ?? "—"}</li><li>Session expires: {system ? time(system.session.expiresAt) : "—"}</li><li>Orders: {system?.rateLimits.ordersPerMinute ?? "—"}/min · Market: {system?.rateLimits.marketPerMinute ?? "—"}/min</li><li>Registration: {system?.rateLimits.registrationPerHour ?? "—"}/hr · Login: {system?.rateLimits.loginPerHour ?? "—"}/hr · Demo: {system?.rateLimits.demoPerHour ?? "—"}/hr</li></ul></section><section className="panel system-copy"><p className="eyebrow">LIVE MARKET PROVENANCE</p><h2>{market?.provider.toUpperCase() ?? "PROVIDER OFFLINE"}</h2><ul><li>Feed: {market?.feed.toUpperCase() ?? "unavailable"} · Freshness: {market?.freshness ?? "unavailable"}</li><li>Quote source: {market ? time(market.asOf) : "unavailable"}</li><li>API received: {market ? time(market.receivedAt) : "unavailable"}</li><li>Verified OHLCV bars: {market?.bars.length ?? 0} · No synthetic replacement prices</li></ul></section></div></>;
}

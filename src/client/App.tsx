import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api, type AuthState, type MarketSnapshot, type Order, type Portfolio, type SystemStatus } from "./api";
import { PriceChart } from "./Chart";

type View = "market" | "portfolio" | "orders" | "system";
const PERIODS = ["5d", "1mo", "3mo", "6mo", "1y"];
const WATCHLIST = ["NVDA", "AAPL", "MSFT", "AMZN", "META"];

export default function App() {
  const [view, setView] = useState<View>("market");
  const [symbol, setSymbol] = useState("NVDA");
  const [search, setSearch] = useState("NVDA");
  const [period, setPeriod] = useState("1mo");
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [health, setHealth] = useState<{ status: string; environment: string; timestamp: string } | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const orderLock = useRef(false);
  const pendingIdempotencyKey = useRef<string | null>(null);

  const loadMarket = useCallback(async (nextSymbol = symbol, nextPeriod = period) => {
    setLoading(true);
    setError(null);
    try {
      setMarket(await api.market(nextSymbol, nextPeriod));
    } catch (cause) {
      setMarket(null);
      setError(formatError(cause));
    } finally {
      setLoading(false);
    }
  }, [symbol, period]);

  const refreshAccount = useCallback(async () => {
    try {
      const [portfolioResult, orderResult] = await Promise.all([api.portfolio(), api.orders()]);
      setPortfolio(portfolioResult);
      setOrders(orderResult.orders);
    } catch (cause) {
      setError(formatError(cause));
    }
  }, []);

  useEffect(() => { void loadMarket(); }, [loadMarket]);
  useEffect(() => {
    api.me().then(setAuth).catch(cause => {
      if (!(cause instanceof ApiClientError && cause.status === 401)) setError(formatError(cause));
    }).finally(() => setAuthLoading(false));
  }, []);
  useEffect(() => { if (auth) void refreshAccount(); }, [auth, refreshAccount]);
  useEffect(() => {
    if (view !== "system" || !auth) return;
    let active = true;
    const refresh = () => {
      api.health().then(result => { if (active) setHealth(result); }).catch(cause => { if (active) setError(formatError(cause)); });
      api.system().then(result => { if (active) setSystem(result); }).catch(cause => { if (active) setError(formatError(cause)); });
      api.market(symbol, period).then(result => { if (active) setMarket(result); }).catch(cause => { if (active) { setMarket(null); setError(formatError(cause)); } });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [view, auth, symbol, period]);

  async function authenticate(action: "demo" | "register" | "login", username: string, passcode: string) {
    setError(null);
    try {
      const next = action === "demo" ? await api.demo() : action === "register" ? await api.register(username, passcode) : await api.login(username, passcode);
      setAuth(next);
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  async function signOut() {
    try {
      await api.logout();
      setAuth(null);
      setPortfolio(null);
      setOrders([]);
      setSystem(null);
    } catch (cause) {
      setError(formatError(cause));
    }
  }

  const cashAndCostBasisCents = useMemo(() => (portfolio?.cashCents ?? 0) + (portfolio?.positions ?? []).reduce(
    (total, position) => total + position.averageCostCents * position.quantity,
    0
  ), [portfolio]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const next = search.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(next)) {
      setError("Enter a valid US equity symbol.");
      return;
    }
    setSymbol(next);
    setView("market");
  }

  async function placeOrder(event: FormEvent) {
    event.preventDefault();
    if (orderLock.current) return;
    orderLock.current = true;
    setSubmittingOrder(true);
    setOrderMessage(null);
    setError(null);
    const idempotencyKey = pendingIdempotencyKey.current ?? crypto.randomUUID();
    pendingIdempotencyKey.current = idempotencyKey;
    try {
      const result = await api.submitOrder({
        symbol,
        side,
        quantity,
        idempotencyKey
      });
      pendingIdempotencyKey.current = null;
      setOrderMessage(result.replayed ? "Idempotency replay: existing order returned safely." : "Order accepted · idempotency key stored · awaiting queue execution.");
      const terminalOrder = await waitForOrder(result.order.id);
      if (terminalOrder?.status === "FILLED") setOrderMessage(`Order filled at $${((terminalOrder.filledPriceCents ?? 0) / 100).toFixed(2)}.`);
      if (terminalOrder?.status === "REJECTED") setOrderMessage(`Order rejected: ${terminalOrder.rejectionReason ?? "business rule failed"}.`);
      if (!terminalOrder) setOrderMessage("Order remains pending. Check Orders for the latest queue state.");
      await refreshAccount();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status < 500) pendingIdempotencyKey.current = null;
      setError(formatError(cause));
    } finally {
      orderLock.current = false;
      setSubmittingOrder(false);
    }
  }

  async function waitForOrder(orderId: string): Promise<Order | null> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise(resolve => window.setTimeout(resolve, 500));
      const result = await api.orders();
      setOrders(result.orders);
      const order = result.orders.find(item => item.id === orderId);
      if (order?.status === "FILLED" || order?.status === "REJECTED") return order;
    }
    return null;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("market")}><span className="brand-mark">A</span><span>ALPHATRACK</span></button>
        <form className="search" onSubmit={submitSearch}>
          <span>⌕</span><input value={search} onChange={event => setSearch(event.target.value.toUpperCase())} aria-label="Search ticker" maxLength={10} />
          <kbd>ENTER</kbd>
        </form>
        <div className="market-state"><span className={`status-dot ${market ? "online" : "offline"}`} />{market ? `${market.provider.toUpperCase()} · ${market.freshness}` : "DATA OFFLINE"}{auth && <button className="signout" onClick={signOut}>SIGN OUT</button>}</div>
      </header>

      <aside className="sidebar">
        <nav>
          <NavButton active={view === "market"} label="Market" glyph="⌁" onClick={() => setView("market")} />
          <NavButton active={view === "portfolio"} label="Portfolio" glyph="◫" onClick={() => setView("portfolio")} />
          <NavButton active={view === "orders"} label="Orders" glyph="↕" onClick={() => setView("orders")} />
          <NavButton active={view === "system"} label="System" glyph="◉" onClick={() => setView("system")} />
        </nav>
        {auth && <button className="sidebar-signout" onClick={signOut}>SIGN OUT</button>}
        <div className="watchlist">
          <p className="eyebrow">WATCHLIST</p>
          {WATCHLIST.map(item => <button key={item} className={item === symbol ? "selected" : ""} onClick={() => { setSearch(item); setSymbol(item); setView("market"); }}><strong>{item}</strong><span>›</span></button>)}
        </div>
        <div className="paper-badge"><span className="status-dot online" /><div><strong>PAPER MODE</strong><small>No real-money execution</small></div></div>
      </aside>

      <main>
        {error && <div className="alert"><strong>REQUEST FAILED</strong><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
        {authLoading ? <div className="loading">CHECKING SIGN-IN…</div> : !auth ? <AuthView onAuthenticate={authenticate} /> : view === "market" && <MarketView market={market} symbol={symbol} period={period} loading={loading} quantity={quantity} side={side} orderMessage={orderMessage} submitting={submittingOrder}
          onPeriod={setPeriod} onQuantity={setQuantity} onSide={setSide} onOrder={placeOrder} />}
        {auth && view === "portfolio" && <PortfolioView portfolio={portfolio} cashAndCostBasisCents={cashAndCostBasisCents} onRefresh={refreshAccount} />}
        {auth && view === "orders" && <OrdersView orders={orders} onRefresh={refreshAccount} />}
        {auth && view === "system" && <SystemView health={health} system={system} market={market} onRefresh={() => {
          api.system().then(setSystem).catch(cause => setError(formatError(cause)));
          api.market(symbol, period).then(setMarket).catch(cause => { setMarket(null); setError(formatError(cause)); });
        }} />}
      </main>
    </div>
  );
}

function AuthView({ onAuthenticate }: { onAuthenticate: (action: "demo" | "register" | "login", username: string, passcode: string) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  async function submit(action: "demo" | "register" | "login") {
    if (busy) return;
    setBusy(true);
    try { await onAuthenticate(action, username, passcode); } finally { setBusy(false); }
  }
  return <section className="panel auth-panel"><p className="eyebrow">SECURE PAPER TRADING</p><h1>Sign in to AlphaTrack</h1>
    <p>Open an instant demo account, or register a username to return to your own paper portfolio.</p>
    <button className="demo-button" disabled={busy} onClick={() => void submit("demo")}>INSTANT DEMO ACCOUNT SIGN-IN →</button>
    <div className="auth-divider">OR USE YOUR ACCOUNT</div>
    <form onSubmit={event => { event.preventDefault(); void submit(mode); }}>
      <label>USERNAME<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} minLength={3} maxLength={32} required /></label>
      <label>PASSCODE<input type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={passcode} onChange={event => setPasscode(event.target.value)} minLength={10} maxLength={128} required /></label>
      <button className="submit-order buy" disabled={busy}>{mode === "login" ? "SIGN IN" : "CREATE ACCOUNT"}</button>
    </form>
    <button className="auth-switch" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Need an account? Register" : "Already registered? Sign in"}</button>
  </section>;
}

function NavButton({ active, label, glyph, onClick }: { active: boolean; label: string; glyph: string; onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}><span>{glyph}</span>{label}</button>;
}

function MarketView(props: {
  market: MarketSnapshot | null;
  symbol: string;
  period: string;
  loading: boolean;
  quantity: number;
  side: "BUY" | "SELL";
  orderMessage: string | null;
  submitting: boolean;
  onPeriod: (period: string) => void;
  onQuantity: (quantity: number) => void;
  onSide: (side: "BUY" | "SELL") => void;
  onOrder: (event: FormEvent) => void;
}) {
  const { market } = props;
  return <>
    <section className="page-title">
      <div><p className="eyebrow">MARKET TERMINAL</p><h1>{props.symbol}<span> / USD</span></h1></div>
      {market && <div className="quote"><strong>${market.price.toFixed(2)}</strong><span className={market.change >= 0 ? "positive" : "negative"}>{market.change >= 0 ? "+" : ""}{market.change.toFixed(2)} ({market.changePercent.toFixed(2)}%)</span></div>}
    </section>
    <div className="terminal-grid">
      <section className="panel chart-panel">
        <div className="panel-head"><div><p className="eyebrow">DAILY CLOSE</p><span className="source-label">SOURCE · {market?.provider.toUpperCase() ?? "UNAVAILABLE"} {market ? `· ${market.feed.toUpperCase()} FEED · ${market.freshness}` : ""}</span></div><div className="periods">{PERIODS.map(item => <button key={item} className={props.period === item ? "active" : ""} onClick={() => props.onPeriod(item)}>{item}</button>)}</div></div>
        {props.loading ? <div className="loading">CONTACTING MARKET DATA PROVIDER…</div> : market ? <PriceChart bars={market.bars} /> : <div className="empty-chart">Live data unavailable. No synthetic fallback is used.</div>}
        {market && <div className="data-foot"><span>AS OF {formatTime(market.asOf)}</span><span>RECEIVED {formatTime(market.receivedAt)}</span><span>{market.bars.length} VERIFIED BARS</span></div>}
      </section>
      <form className="panel order-ticket" onSubmit={props.onOrder}>
        <div className="panel-head"><div><p className="eyebrow">PAPER ORDER</p><h2>{props.symbol}</h2></div><span className="paper-tag">SIMULATION</span></div>
        <div className="segmented"><button type="button" className={props.side === "BUY" ? "buy active" : ""} onClick={() => props.onSide("BUY")}>BUY</button><button type="button" className={props.side === "SELL" ? "sell active" : ""} onClick={() => props.onSide("SELL")}>SELL</button></div>
        <label>ORDER TYPE<input value="MARKET" disabled /></label>
        <label>WHOLE SHARES<input type="number" min="1" max="100000" step="1" value={props.quantity} onChange={event => props.onQuantity(Number(event.target.value))} /></label>
        <div className="estimate"><span>Estimated value</span><strong>{market ? `$${(market.price * props.quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</strong></div>
        <button className={`submit-order ${props.side.toLowerCase()}`} disabled={!market || props.submitting}>{props.submitting ? "PROCESSING…" : `SUBMIT ${props.side} ORDER`}</button>
        <p className="trust-copy">The server selects the execution price and validates cash, holdings, and identity.</p>
        {props.orderMessage && <p className="success-message">{props.orderMessage}</p>}
      </form>
    </div>
  </>;
}

function PortfolioView({ portfolio, cashAndCostBasisCents, onRefresh }: { portfolio: Portfolio | null; cashAndCostBasisCents: number; onRefresh: () => void }) {
  return <><PageHeading eyebrow="PAPER ACCOUNT" title="Portfolio" action={onRefresh} />
    <div className="metric-grid"><Metric label="CASH + COST BASIS" value={formatCents(cashAndCostBasisCents)} /><Metric label="AVAILABLE CASH" value={formatCents(portfolio?.cashCents ?? 0)} /><Metric label="OPEN POSITIONS" value={String(portfolio?.positions.length ?? 0)} /><Metric label="LEDGER VERSION" value={String(portfolio?.version ?? 0)} /></div>
    <section className="panel table-panel"><div className="panel-head"><div><p className="eyebrow">SERVER-AUTHORITATIVE POSITIONS</p><h2>Holdings</h2></div></div>
      <table><thead><tr><th>SYMBOL</th><th>QUANTITY</th><th>AVG COST</th><th>VERSION</th></tr></thead><tbody>{portfolio?.positions.length ? portfolio.positions.map(position => <tr key={position.symbol}><td><strong>{position.symbol}</strong></td><td>{position.quantity}</td><td>{formatCents(position.averageCostCents)}</td><td>v{position.version}</td></tr>) : <tr><td colSpan={4} className="empty-row">No positions. Submit a paper order from the Market view.</td></tr>}</tbody></table>
    </section></>;
}

function OrdersView({ orders, onRefresh }: { orders: Order[]; onRefresh: () => void }) {
  return <><PageHeading eyebrow="EXECUTION PIPELINE" title="Orders" action={onRefresh} />
    <p className="pipeline-note">Lifecycle: PENDING → PROCESSING → FILLED or REJECTED · Each order has a unique account-scoped idempotency key.</p>
    <section className="panel table-panel"><table><thead><tr><th>ORDER / TIME</th><th>SYMBOL</th><th>SIDE</th><th>QUANTITY</th><th>STATUS</th><th>FILL</th></tr></thead><tbody>{orders.length ? orders.map(order => <tr key={order.id}><td><strong>{order.id.slice(0, 8)}</strong><small>{formatTime(order.requestedAt)}</small></td><td><strong>{order.symbol}</strong></td><td className={order.side === "BUY" ? "positive" : "negative"}>{order.side}</td><td>{order.quantity}</td><td><span className={`order-status ${order.status.toLowerCase()}`}>{order.status}</span>{order.rejectionReason && <small>{order.rejectionReason}</small>}</td><td>{order.filledPriceCents ? formatCents(order.filledPriceCents) : "—"}</td></tr>) : <tr><td colSpan={6} className="empty-row">No orders have been submitted.</td></tr>}</tbody></table></section></>;
}

function SystemView({ health, system, market, onRefresh }: { health: { status: string; environment: string; timestamp: string } | null; system: SystemStatus | null; market: MarketSnapshot | null; onRefresh: () => void }) {
  return <><PageHeading eyebrow="OPERATIONS" title="System health" action={onRefresh} />
    <div className="metric-grid"><Metric label="API / D1" value={health?.status === "ok" && system?.database === "ok" ? "ONLINE" : "CHECKING"} good={health?.status === "ok" && system?.database === "ok"} /><Metric label="SIGNED-IN USER" value={system?.session.kind.toUpperCase() ?? "CHECKING"} good={system?.session.authenticated} /><Metric label="MARKET FEED" value={market?.feed.toUpperCase() ?? "UNAVAILABLE"} good={Boolean(market)} /><Metric label="DATA FRESHNESS" value={market?.freshness ?? "UNAVAILABLE"} good={market?.freshness === "LIVE"} /></div>
    <section className="panel system-copy"><p className="eyebrow">LIVE D1 ORDER STATES · YOUR ACCOUNT</p><h2>Order pipeline</h2><div className="metric-grid">{(["PENDING", "PROCESSING", "FILLED", "REJECTED"] as const).map(status => <Metric key={status} label={status} value={system ? String(system.orderCounts[status]) : "—"} />)}</div><p>Observed {system ? formatTime(system.observedAt) : "—"} · Queue configured: {system?.queue.configured ? "YES" : "UNKNOWN"} · Queue depth: {system?.queue.depth ?? "unavailable"} · DLQ depth: {system?.queue.dlqDepth ?? "unavailable"}</p></section>
    <section className="panel system-copy"><p className="eyebrow">LIVE MARKET PROVENANCE</p><h2>{market?.provider.toUpperCase() ?? "Provider unavailable"}</h2><ul><li>Feed: {market?.feed.toUpperCase() ?? "unavailable"}; quote freshness: {market?.freshness ?? "unavailable"}.</li><li>Quote source time: {market ? formatTime(market.asOf) : "unavailable"}.</li><li>Received by API: {market ? formatTime(market.receivedAt) : "unavailable"}.</li><li>Provider failure shows an error; no synthetic replacement prices.</li></ul></section>
    <section className="panel system-copy"><p className="eyebrow">AUTHENTICATION AND RATE LIMITS</p><h2>Runtime policy</h2><ul><li>Authenticated user: {system?.session.userId.slice(0, 8) ?? "—"} · {system?.session.kind ?? "—"} · expires {system ? formatTime(system.session.expiresAt) : "—"}.</li><li>Order submissions: {system?.rateLimits.ordersPerMinute ?? "—"} per minute; market reads: {system?.rateLimits.marketPerMinute ?? "—"} per minute.</li><li>Registration: {system?.rateLimits.registrationPerHour ?? "—"} per hour; login: {system?.rateLimits.loginPerHour ?? "—"} per hour; instant demo: {system?.rateLimits.demoPerHour ?? "—"} per hour.</li></ul></section></>;
}

function PageHeading({ eyebrow, title, action }: { eyebrow: string; title: string; action?: () => void }) {
  return <section className="page-title"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action && <button className="refresh" onClick={action}>REFRESH ↻</button>}</section>;
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return <div className="panel metric"><p className="eyebrow">{label}</p><strong className={good ? "positive" : ""}>{value}</strong></div>;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatCents(cents: number) {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatError(error: unknown) {
  return error instanceof ApiClientError ? `${error.message}${error.requestId ? ` · Request ${error.requestId}` : ""}` : error instanceof Error ? error.message : "Unexpected request failure";
}

import { useState } from "react";
import type { Bar } from "./api";

type ChartMode = "area" | "candles";

export function PriceChart({ bars }: { bars: Bar[] }) {
  const [mode, setMode] = useState<ChartMode>("area");
  const [hovered, setHovered] = useState<number | null>(null);
  const valid = bars.filter(bar => [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite));
  if (!valid.length) return <div className="empty-chart">No verified OHLCV bars available.</div>;

  const width = 1000;
  const left = 12;
  const right = 942;
  const top = 20;
  const bottom = 239;
  const volumeTop = 270;
  const volumeBottom = 327;
  const low = Math.min(...valid.map(bar => bar.low));
  const high = Math.max(...valid.map(bar => bar.high));
  const span = Math.max(high - low, Math.abs(high) * 0.001, 0.01);
  const min = low - span * 0.08;
  const max = high + span * 0.08;
  const maxVolume = Math.max(...valid.map(bar => bar.volume), 1);
  const x = (index: number) => left + (index + 0.5) * (right - left) / valid.length;
  const y = (price: number) => bottom - (price - min) / (max - min) * (bottom - top);
  const line = valid.map((bar, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(bar.close).toFixed(2)}`).join(" ");
  const area = `${line} L${x(valid.length - 1)},${bottom} L${x(0)},${bottom} Z`;
  const activeIndex = hovered ?? valid.length - 1;
  const active = valid[activeIndex];
  const candleWidth = Math.max(1.3, Math.min(11, (right - left) / valid.length * 0.68));

  function scrub(clientX: number, element: SVGSVGElement) {
    const bounds = element.getBoundingClientRect();
    const coordinate = (clientX - bounds.left) / bounds.width * width;
    setHovered(Math.max(0, Math.min(valid.length - 1, Math.floor((coordinate - left) / (right - left) * valid.length))));
  }

  return <div className="chart-wrap">
    <div className="chart-toolbar"><div className="chart-hud"><span>{new Date(active.timestamp).toLocaleString()}</span><span>O <b>{active.open.toFixed(2)}</b></span><span>H <b>{active.high.toFixed(2)}</b></span><span>L <b>{active.low.toFixed(2)}</b></span><span>C <b>{active.close.toFixed(2)}</b></span><span>VOL <b>{active.volume.toLocaleString()}</b></span></div><div className="chart-modes"><button type="button" className={mode === "area" ? "active" : ""} onClick={() => setMode("area")}>AREA</button><button type="button" className={mode === "candles" ? "active" : ""} onClick={() => setMode("candles")}>CANDLES</button></div></div>
    <svg viewBox="0 0 1000 350" role="img" aria-label={`${mode === "area" ? "Area" : "Candlestick"} price chart with volume bars`} onPointerMove={event => scrub(event.clientX, event.currentTarget)} onPointerLeave={() => setHovered(null)}>
      <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#56dbba" stopOpacity=".24"/><stop offset="100%" stopColor="#56dbba" stopOpacity="0"/></linearGradient></defs>
      {[0, 1, 2, 3, 4].map(step => <g key={step}><line x1={left} y1={top + step * (bottom - top) / 4} x2={right} y2={top + step * (bottom - top) / 4} className="grid-line"/><text x="992" y={top + step * (bottom - top) / 4 + 4} textAnchor="end" className="axis-label">{(max - step * (max - min) / 4).toFixed(2)}</text></g>)}
      <line x1={left} y1="257" x2={right} y2="257" className="grid-line"/>
      {valid.map((bar, index) => <rect key={`v-${index}`} x={x(index) - Math.max(1, candleWidth / 2)} y={volumeBottom - bar.volume / maxVolume * (volumeBottom - volumeTop)} width={Math.max(2, candleWidth)} height={Math.max(1, bar.volume / maxVolume * (volumeBottom - volumeTop))} fill={bar.close >= bar.open ? "#56dbba" : "#f47988"} opacity=".34"/>)}
      {mode === "area" ? <><path d={area} fill="url(#chart-fill)"/><path d={line} fill="none" stroke="#56dbba" strokeWidth="2.5" vectorEffect="non-scaling-stroke"/></> : valid.map((bar, index) => <g key={`c-${index}`}><line x1={x(index)} x2={x(index)} y1={y(bar.high)} y2={y(bar.low)} stroke={bar.close >= bar.open ? "#56dbba" : "#f47988"} strokeWidth="1.5"/><rect x={x(index) - candleWidth / 2} y={Math.min(y(bar.open), y(bar.close))} width={candleWidth} height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))} fill={bar.close >= bar.open ? "#56dbba" : "#f47988"}/></g>)}
      {hovered !== null && <g className="crosshair"><line x1={x(hovered)} x2={x(hovered)} y1={top} y2={volumeBottom} stroke="#bacbc9" strokeDasharray="3 5" opacity=".7"/><line x1={left} x2={right} y1={y(active.close)} y2={y(active.close)} stroke="#bacbc9" strokeDasharray="3 5" opacity=".4"/><circle cx={x(hovered)} cy={y(active.close)} r="4" fill="#56dbba"/></g>}
    </svg>
    <div className="chart-axis"><span>{new Date(valid[0].timestamp).toLocaleDateString()}</span><span>VOLUME</span><span>{new Date(valid[valid.length - 1].timestamp).toLocaleDateString()}</span></div>
  </div>;
}

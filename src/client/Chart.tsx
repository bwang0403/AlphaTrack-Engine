import type { Bar } from "./api";

export function PriceChart({ bars }: { bars: Bar[] }) {
  if (bars.length < 2) return <div className="empty-chart">No chart data available</div>;
  const width = 1000;
  const height = 360;
  const padding = 24;
  const closes = bars.map(bar => bar.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const points = closes.map((value, index) => {
    const x = padding + (index / (closes.length - 1)) * (width - padding * 2);
    const y = padding + ((max - value) / range) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const area = `${padding},${height - padding} ${points} ${width - padding},${height - padding}`;

  return (
    <div className="chart-wrap" role="img" aria-label="Historical daily closing price chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#66e3ff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#66e3ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={padding} y1={padding} x2={width - padding} y2={padding} className="grid-line" />
        <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} className="grid-line" />
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} className="grid-line" />
        <polygon points={area} fill="url(#chart-fill)" />
        <polyline points={points} fill="none" stroke="#66e3ff" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-range"><span>${max.toFixed(2)}</span><span>${min.toFixed(2)}</span></div>
    </div>
  );
}

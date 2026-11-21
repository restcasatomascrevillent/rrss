import { formatNumber } from '../../../supabase/functions/_shared/analytics/analyst';

/**
 * Gráfico de barras diario, en SVG y sin dependencias. Los días sin cifra no
 * llevan barra (no se dibujan como cero) y se dice debajo.
 */
export function BarChart({
  title,
  points,
  testId,
}: {
  title: string;
  points: Array<{ date: string; value: number | null }>;
  testId?: string;
}) {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = Math.max(1, ...values);
  const missing = points.filter((p) => p.value === null).length;
  const width = 640;
  const height = 160;
  const step = width / Math.max(1, points.length);
  const label = `${title}: ${values.length} días con cifra${missing ? `, ${missing} sin cifra` : ''}; máximo ${formatNumber(max)}.`;
  return (
    <figure data-testid={testId}>
      <svg viewBox={`0 0 ${width} ${height + 18}`} role="img" aria-label={label} className="h-44 w-full">
        <title>{label}</title>
        <line x1={0} x2={width} y1={height} y2={height} className="stroke-border" strokeWidth={1} />
        {points.map((p, i) =>
          p.value === null ? null : (
            <rect
              key={p.date}
              x={i * step + step * 0.15}
              width={step * 0.7}
              y={height - Math.max(1, (p.value / max) * (height - 8))}
              height={Math.max(1, (p.value / max) * (height - 8))}
              rx={2}
              className="fill-primary"
            >
              <title>{`${p.date}: ${formatNumber(p.value)}`}</title>
            </rect>
          ),
        )}
        {points.map((p, i) =>
          i % Math.ceil(points.length / 8) === 0 ? (
            <text
              key={`l-${p.date}`}
              x={i * step + step / 2}
              y={height + 14}
              textAnchor="middle"
              className="fill-muted text-[10px]"
            >
              {p.date.slice(8, 10)}/{p.date.slice(5, 7)}
            </text>
          ) : null,
        )}
      </svg>
      {missing > 0 && (
        <figcaption className="mt-1 text-xs text-muted">
          {missing} día{missing === 1 ? '' : 's'} sin cifra (sin medir todavía o sin dato de Meta): no se dibujan como
          cero.
        </figcaption>
      )}
    </figure>
  );
}

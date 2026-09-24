import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassPlus } from '@phosphor-icons/react/MagnifyingGlassPlus';
import { MagnifyingGlassMinus } from '@phosphor-icons/react/MagnifyingGlassMinus';
import { ArrowCounterClockwise } from '@phosphor-icons/react/ArrowCounterClockwise';
import { ChartController, type ChartState } from './chart-controller.js';
import { nearestSampleIndex, panViewport, pixelPosition, prepareSamples, sampleBounds, standardGeometry, zoomViewport, type ChartSample, type ChartViewport } from './chart-model.js';
import type { NativeChartFrame } from './bridge.js';
import { useChartEnvironment } from './use-chart-environment.js';
// 样式由 Studio 静态 styles 入口加载，组件不挂载全局 bundle。

export interface NativeChartSurfaceProps {
  samples: readonly ChartSample[];
  title: string;
  xLabel: string;
  yLabel: string;
  onSelect(id: string): void;
  getLabel?(id: string): string;
}

/** 数据真正变化才重建 Surface；普通父级 rerender 不重新分配 native session。 */
export function NativeChartSurface(props: NativeChartSurfaceProps): React.JSX.Element {
  const prepared = useMemo(() => prepareSamples(props.samples), [props.samples]);
  const [data, setData] = useState(() => ({ ...prepared, revision: 0 }));
  if (data.omitted !== prepared.omitted || data.samples.length !== prepared.samples.length
    || data.samples.some((s, i) => s.id !== prepared.samples[i].id || s.timestamp !== prepared.samples[i].timestamp || s.value !== prepared.samples[i].value)) {
    setData({ ...prepared, revision: data.revision + 1 });
  }
  return <ChartSurface key={data.revision} {...props} samples={data.samples} omitted={data.omitted} />;
}

function ChartSurface({ samples, omitted, title, xLabel, yLabel, onSelect, getLabel }: NativeChartSurfaceProps & { omitted: number }): React.JSX.Element {
  const { t, i18n } = useTranslation('performance');
  const text = (key: string): string => t(`NativeChart.${key}`);
  const [surfaceId] = useState(() => `chart-${crypto.randomUUID()}`);
  const plotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const environment = useChartEnvironment(plotRef);
  const bounds = useMemo(() => sampleBounds(samples), [samples]);
  const [view, setView] = useState(bounds);
  const viewRef = useRef(view);
  const [cursor, setCursor] = useState<number>();
  const [state, setState] = useState<ChartState>({ mode: window.harnessNativeChart ? 'loading' : 'standard' });
  const [frame, setFrame] = useState<NativeChartFrame>();
  const [standard, setStandard] = useState(false);
  const [retry, setRetry] = useState(0);
  const [started, setStarted] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [listPage, setListPage] = useState(0);
  const controller = useRef<ChartController | null>(null);
  const inputRaf = useRef<number | undefined>(undefined);
  const probeSequence = useRef(0);
  const drag = useRef<{ pointerId: number; x: number; view: ChartViewport; moved: boolean } | undefined>(undefined);
  const dragging = useRef(false);
  const selected = cursor === undefined ? undefined : samples[cursor];
  const number = useMemo(() => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 3 }), [i18n.language]);
  const date = useCallback((timestamp: number) => new Date(timestamp).toLocaleString(i18n.language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }), [i18n.language]);
  const label = (sample: ChartSample): string => `${getLabel?.(sample.id) ?? sample.id} · ${date(sample.timestamp)} · ${number.format(sample.value)} ${yLabel}`;
  const geometry = useMemo(() => standardGeometry(samples, view, environment.width, environment.height), [samples, view, environment.width, environment.height]);
  const matchingFrame = frame?.from === view.from && frame.to === view.to && frame.width === environment.width && frame.height === environment.height ? frame : undefined;
  const native = state.mode === 'native';
  const yMin = native && matchingFrame ? matchingFrame.yMin : geometry.yMin;
  const yMax = native && matchingFrame ? matchingFrame.yMax : geometry.yMax;
  const cursorVisible = selected && selected.timestamp >= view.from && selected.timestamp <= view.to;

  useEffect(() => { if (environment.active) setStarted(true); }, [environment.active]);
  useEffect(() => {
    setFrame(undefined);
    if (standard || !window.harnessNativeChart || !samples.length) { setState({ mode: 'standard' }); return; }
    if (!started) return;
    let live = true;
    const current = new ChartController(window.harnessNativeChart, surfaceId, samples, {
      state: value => { if (live) setState(value); },
      frame: value => { if (live) setFrame(value); },
    });
    controller.current = current;
    void current.start();
    return () => {
      live = false;
      controller.current = null;
      // cleanup 不能返回 Promise；排空由共享队列等待，迟到 open 也会 close。
      void current.dispose().catch(() => undefined);
    };
  }, [samples, surfaceId, standard, retry, started]);
  useEffect(() => {
    const current = controller.current;
    current?.setActive(environment.active);
    if (environment.background && environment.line && environment.measured) {
      setFrame(undefined);
      current?.request({ ...view, width: environment.width, height: environment.height, background: environment.background, line: environment.line });
    }
  }, [view, environment, standard, retry, started]);
  useEffect(() => () => { if (inputRaf.current !== undefined) cancelAnimationFrame(inputRaf.current); probeSequence.current++; }, []);
  useEffect(() => {
    if (!environment.active && inputRaf.current !== undefined) { cancelAnimationFrame(inputRaf.current); inputRaf.current = undefined; }
  }, [environment.active]);

  const changeView = useCallback((next: ChartViewport) => {
    viewRef.current = next;
    if (inputRaf.current !== undefined) return;
    inputRaf.current = requestAnimationFrame(() => { inputRaf.current = undefined; setView(viewRef.current); });
  }, []);
  const zoom = (factor: number, ratio = 0.5): void => changeView(zoomViewport(viewRef.current, factor, ratio, bounds));
  const ratioAt = (clientX: number): number => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  };
  const probe = (ratio: number): number => {
    const current = viewRef.current;
    const timestamp = current.from + (current.to - current.from) * ratio;
    const index = nearestSampleIndex(samples, timestamp);
    const sequence = ++probeSequence.current;
    setCursor(index < 0 ? undefined : index);
    controller.current?.probe(timestamp, hit => { if (probeSequence.current === sequence) setCursor(hit.index); });
    return index;
  };
  const select = (index: number | undefined): void => { if (index !== undefined && samples[index]) onSelect(samples[index].id); };
  const keyDown = (event: KeyboardEvent<HTMLCanvasElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1;
    if (event.key.startsWith('Arrow')) {
      event.preventDefault(); probeSequence.current++; controller.current?.clearProbe();
      if (event.shiftKey) {
        const next = Math.max(0, Math.min(samples.length - 1, (cursor ?? (direction > 0 ? -1 : samples.length)) + direction));
        if (!samples[next]) return;
        setCursor(next);
        const current = viewRef.current, at = samples[next].timestamp;
        if (at < current.from || at > current.to) changeView(panViewport(current, at - (current.from + current.to) / 2, bounds));
      } else changeView(panViewport(viewRef.current, direction * (viewRef.current.to - viewRef.current.from) * 0.1, bounds));
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.5); }
    else if (event.key === '-') { event.preventDefault(); zoom(2); }
    else if (event.key === 'Home') { event.preventDefault(); changeView(bounds); }
    else if (event.key === 'Enter') { event.preventDefault(); select(cursor); }
    else if (event.key === 'Escape') {
      event.preventDefault(); probeSequence.current++; controller.current?.clearProbe(); setCursor(undefined);
    }
  };
  const cancelDrag = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = undefined; dragging.current = true;
    probeSequence.current++; controller.current?.clearProbe();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>): void => {
    if (drag.current) {
      if (drag.current.pointerId !== event.pointerId) return;
      const delta = event.clientX - drag.current.x;
      drag.current.moved ||= Math.abs(delta) > 3;
      if (drag.current.moved) {
        dragging.current = true;
        changeView(panViewport(drag.current.view, -delta / Math.max(1, event.currentTarget.getBoundingClientRect().width) * (drag.current.view.to - drag.current.view.from), bounds));
      }
    } else probe(ratioAt(event.clientX));
  };
  // 非 passive wheel 监听只属于图表；相同视域计算同时服务 native 和 Standard。
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => undefined);
  wheelHandler.current = event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !event.cancelable
      || !Number.isFinite(event.deltaY) || !Number.isFinite(event.deltaX) || event.deltaY === 0
      || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const style = getComputedStyle(canvas);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.getBoundingClientRect().height : 1;
    const pixels = event.deltaY * unit;
    if (!Number.isFinite(pixels)) return;
    event.preventDefault(); zoom(Math.exp(Math.max(-1, Math.min(1, pixels * 0.002))), ratioAt(event.clientX));
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const listener = (event: WheelEvent): void => wheelHandler.current(event);
    canvas.addEventListener('wheel', listener, { passive: false });
    return () => canvas.removeEventListener('wheel', listener);
  }, []);

  const error = standard ? undefined : environment.error ?? (state.mode === 'error' ? state.reason : undefined);
  const status = error ? text('nativeError') : state.mode === 'loading' || (native && !matchingFrame) ? text('loading')
    : native ? `${text('native')} · ${state.backend}` : text('standard');
  return <section className="native-chart" data-testid="native-chart-root" data-backend={state.mode}
    data-samples={samples.length} data-from={view.from} data-to={view.to} aria-labelledby={`${surfaceId}-title`}>
    <div className="native-chart-toolbar">
      <h3 id={`${surfaceId}-title`}>{title}</h3>
      <span data-testid="native-chart-status" role="status">{status}</span>
      <div className="native-chart-actions" role="group" aria-label={text('controls')}>
        <button data-testid="native-chart-zoom-in" title={text('zoomIn')} aria-label={text('zoomIn')} disabled={!samples.length} onClick={() => zoom(0.5)}><MagnifyingGlassPlus size={16} aria-hidden="true" /></button>
        <button title={text('zoomOut')} aria-label={text('zoomOut')} disabled={!samples.length} onClick={() => zoom(2)}><MagnifyingGlassMinus size={16} aria-hidden="true" /></button>
        <button data-testid="native-chart-reset" title={text('reset')} aria-label={text('reset')} disabled={!samples.length} onClick={() => changeView(bounds)}><ArrowCounterClockwise size={16} aria-hidden="true" /></button>
      </div>
    </div>
    {error && <div className="native-chart-error" role="alert"><span>{text('nativeError')} {error}</span>
      <button onClick={() => { setStandard(true); }}>{text('useStandard')}</button>
      <button onClick={() => { setStandard(false); setRetry(value => value + 1); }}>{text('retry')}</button>
    </div>}
    {!samples.length ? <p className="native-chart-note">{text('empty')}</p> : <>
      <div className="native-chart-y-label">{yLabel} · {number.format(yMin)} – {number.format(yMax)}</div>
      <div ref={plotRef} className="native-chart-plot">
        <canvas id={surfaceId} ref={canvasRef} data-testid="native-chart-canvas" tabIndex={0} role="img"
          aria-label={title} aria-describedby={`${surfaceId}-help ${surfaceId}-cursor`} onKeyDown={keyDown}
          onFocus={() => { if (cursor === undefined) setCursor(Math.max(0, nearestSampleIndex(samples, viewRef.current.from))); }}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current) return;
            event.currentTarget.focus(); probeSequence.current++; controller.current?.clearProbe(); dragging.current = false;
            drag.current = { pointerId: event.pointerId, x: event.clientX, view: viewRef.current, moved: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={pointerMove}
          onPointerUp={event => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={cancelDrag}
          onClick={event => { if (!dragging.current) select(probe(ratioAt(event.clientX))); }}
          onPointerLeave={() => { probeSequence.current++; controller.current?.clearProbe(); if (document.activeElement !== canvasRef.current) setCursor(undefined); }} />
        {(state.mode === 'standard' || !native || !matchingFrame) && <svg className="native-chart-standard" data-testid="native-chart-standard" viewBox={`0 0 ${environment.width} ${environment.height}`} preserveAspectRatio="none" aria-hidden="true">
          {state.mode === 'standard' && <>
            <polyline points={geometry.polyline} vectorEffect="non-scaling-stroke" />
            {geometry.points.length <= 64 && geometry.points.map(point => <circle key={point.id} data-sample-id={point.id} cx={point.x} cy={point.y} r={3} />)}
          </>}
        </svg>}
        {cursorVisible && <svg className="native-chart-crosshair" viewBox={`0 0 ${environment.width} ${environment.height}`} preserveAspectRatio="none" aria-hidden="true">
          <line x1={pixelPosition(selected.timestamp, view.from, view.to, environment.width)} x2={pixelPosition(selected.timestamp, view.from, view.to, environment.width)} y1={0} y2={environment.height} vectorEffect="non-scaling-stroke" />
          <circle cx={pixelPosition(selected.timestamp, view.from, view.to, environment.width)} cy={environment.height - pixelPosition(selected.value, yMin, yMax, environment.height)} r={4} />
        </svg>}
      </div>
      <div className="native-chart-x-axis"><time dateTime={new Date(view.from).toISOString()}>{date(view.from)}</time><time dateTime={new Date(view.to).toISOString()}>{date(view.to)}</time></div>
      <div className="native-chart-x-label">{xLabel}</div>
      <p id={`${surfaceId}-cursor`} data-testid="native-chart-cursor" className="native-chart-cursor" aria-live="polite" aria-atomic="true">{selected ? label(selected) : text('probeHint')}</p>
      <p id={`${surfaceId}-help`} className="native-chart-note">{text('keyboard')}</p>
      <details className="native-chart-data" onToggle={event => setListOpen(event.currentTarget.open)}>
        <summary>{t('NativeChart.data', { count: samples.length })}</summary>
        {listOpen && <>
          <ol start={listPage * 50 + 1}>{samples.slice(listPage * 50, (listPage + 1) * 50).map(sample => <li key={sample.id}><button onClick={() => onSelect(sample.id)}>{label(sample)}</button></li>)}</ol>
          {samples.length > 50 && <div className="native-chart-pagination"><button disabled={listPage === 0} onClick={() => setListPage(value => value - 1)}>{t('previous')}</button><span>{t('page', { page: listPage + 1, total: Math.ceil(samples.length / 50) })}</span><button disabled={(listPage + 1) * 50 >= samples.length} onClick={() => setListPage(value => value + 1)}>{t('next')}</button></div>}
        </>}
      </details>
    </>}
    <details className="native-chart-diagnostics"><summary>{text('diagnostics')}</summary>
      <p>{t('NativeChart.retained', { count: samples.length })}{omitted ? ` · ${t('NativeChart.omitted', { count: omitted })}` : ''}</p>
      {state.reason && <p>{state.reason}</p>}
      {native && frame ? <dl>{([
        ['visible', frame.visiblePoints], ['vertices', frame.renderedVertices], ['lod', frame.lodMs],
        ['encode', frame.encodeMs], ['gpuWait', frame.gpuWaitMs], ['canvas', frame.canvasMs],
      ] as const).map(([key, value]) => <div key={key}><dt>{text(key)}</dt><dd>{number.format(value)}</dd></div>)}
        <div><dt>{text('gpuExecution')}</dt><dd>{text('notMeasured')}</dd></div>
      </dl> : <p>{text('noNativeMetrics')}</p>}
    </details>
  </section>;
}

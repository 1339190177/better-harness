import { useEffect, useState, type RefObject } from 'react';
import { useStudioTheme } from '../studio-theme.js';
import { parseComputedRGB, surfaceSize, type ChartRGB } from './chart-model.js';

export interface ChartEnvironment {
  width: number; height: number; active: boolean; measured: boolean;
  background?: ChartRGB; line?: ChartRGB; error?: string;
}

export function useChartEnvironment(ref: RefObject<HTMLElement | null>): ChartEnvironment {
  const theme = useStudioTheme();
  const [environment, setEnvironment] = useState<ChartEnvironment>({ width: 1, height: 1, active: false, measured: false });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let intersecting = false, raf: number | undefined;
    const measure = (): void => {
      raf = undefined;
      const rect = element.getBoundingClientRect();
      const active = !document.hidden && intersecting && rect.width > 0 && rect.height > 0;
      const size = surfaceSize(rect.width, rect.height, window.devicePixelRatio || 1);
      try {
        const style = getComputedStyle(element);
        const next: ChartEnvironment = {
          ...size, active, measured: rect.width > 0 && rect.height > 0,
          background: parseComputedRGB(style.backgroundColor), line: parseComputedRGB(style.color),
        };
        setEnvironment(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      } catch (error) {
        // 调色板解析失败不能破坏 Standard 的实际尺寸或可访问数据。
        setEnvironment({ ...size, active: false, measured: rect.width > 0 && rect.height > 0, error: String(error) });
      }
    };
    const schedule = (): void => { if (raf === undefined) raf = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const intersection = new IntersectionObserver(entries => {
      intersecting = entries[0]?.isIntersecting ?? false;
      // 立即停止不可见 Surface；不要等后台暂停的 rAF 才关掉调度。
      if (!intersecting) setEnvironment(previous => previous.active ? { ...previous, active: false } : previous);
      schedule();
    });
    const mutation = new MutationObserver(schedule);
    const visibility = (): void => { if (document.hidden) { setEnvironment(previous => ({ ...previous, active: false })); } else schedule(); };
    resize.observe(element);
    intersection.observe(element);
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf);
      resize.disconnect(); intersection.disconnect(); mutation.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', schedule);
    };
  }, [ref, theme]);
  return environment;
}

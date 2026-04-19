'use client';

import { useEffect, useRef, memo } from 'react';

interface TradingViewChartProps {
  symbol?: string;
  interval?: string;
  height?: string | number;
}

/**
 * TradingView Advanced Chart widget (dark theme).
 * Loads the TradingView library via script tag and renders a full-featured chart.
 */
function TradingViewChart({
  symbol = 'COINBASE:ETHUSD',
  interval = '60',
  height = '100%',
}: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const chartIdRef = useRef<string | null>(null);

  // Generate a stable ID on mount (client-side only)
  useEffect(() => {
    if (!chartIdRef.current) {
      chartIdRef.current = `tv_chart_${Math.random().toString(36).slice(2, 9)}`;
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || !chartIdRef.current) return;

    // Clear previous widget
    const container = containerRef.current;
    container.innerHTML = '';

    // Create chart div
    const chartDiv = document.createElement('div');
    chartDiv.id = chartIdRef.current;
    chartDiv.style.width = '100%';
    chartDiv.style.height = '100%';
    container.appendChild(chartDiv);

    // Load TradingView script if not already loaded
    const scriptId = 'tradingview-widget-script';
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;

    const initWidget = () => {
      if (typeof (window as any).TradingView === 'undefined') return;

      try {
        widgetRef.current = new (window as any).TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1', // Candlestick
          locale: 'en',
          toolbar_bg: '#0a0a0f',
          backgroundColor: '#0a0a0f',
          gridColor: 'rgba(255, 255, 255, 0.04)',
          enable_publishing: false,
          allow_symbol_change: false,
          hide_side_toolbar: false,   // Hyperliquid-style drawing-tools rail
          hide_top_toolbar: false,
          hide_legend: false,
          details: false,
          hotlist: false,
          calendar: false,
          withdateranges: true,       // bottom "5y 1y 6m 3m 1m 5d 1d" range tabs
          show_popup_button: false,
          studies: [],                // keep chart clean by default
          container_id: chartDiv.id,
          loading_screen: {
            backgroundColor: '#0a0a0f',
            foregroundColor: '#ff7a3d',
          },
          overrides: {
            'paneProperties.background': '#0a0a0f',
            'paneProperties.backgroundType': 'solid',
            'paneProperties.vertGridProperties.color': 'rgba(255,255,255,0.04)',
            'paneProperties.horzGridProperties.color': 'rgba(255,255,255,0.04)',
            'scalesProperties.textColor': 'rgba(255,255,255,0.55)',
            'scalesProperties.lineColor': 'rgba(255,255,255,0.08)',
            'mainSeriesProperties.candleStyle.upColor': '#22c55e',
            'mainSeriesProperties.candleStyle.downColor': '#ef4444',
            'mainSeriesProperties.candleStyle.borderUpColor': '#22c55e',
            'mainSeriesProperties.candleStyle.borderDownColor': '#ef4444',
            'mainSeriesProperties.candleStyle.wickUpColor': '#22c55e',
            'mainSeriesProperties.candleStyle.wickDownColor': '#ef4444',
          },
        });
      } catch (e) {
        console.error('[TradingView] Widget init error:', e);
      }
    };

    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://s3.tradingview.com/tv.js';
      script.async = true;
      script.onload = initWidget;
      document.head.appendChild(script);
    } else {
      // Script already loaded, init directly
      initWidget();
    }

    return () => {
      widgetRef.current = null;
    };
  }, [symbol, interval]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height }}
      className="rounded-xl overflow-hidden"
    />
  );
}

export default memo(TradingViewChart);

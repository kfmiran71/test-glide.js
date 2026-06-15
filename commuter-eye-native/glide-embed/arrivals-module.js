import React, { useCallback, useEffect, useMemo, useRef, useState } from 'https://esm.sh/react@19.1.0';
import { createRoot } from 'https://esm.sh/react-dom@19.1.0/client';

const h = React.createElement;

const API_URL = 'https://glide-write-test.onrender.com/push-arrivals';
const DEFAULT_STATION_NAME = '59 St-Columbus Circle';
const REFRESH_INTERVAL_MS = 15000;
const PULL_THRESHOLD = 74;
const DEBUG_FETCH = new URLSearchParams(window.location.search).has('debug');

const PLATFORM_IDS = {
  uptown: 'A24N',
  downtown: 'A24S',
};

const DIRECTION_LABELS = {
  uptown: 'UPTOWN',
  downtown: 'DOWNTOWN',
};

const BULLET_ASSETS = Object.freeze({
  A: './assets/route-bullet-a.png',
  D: './assets/route-bullet-d.png',
});

const FALLBACK_COLORS = Object.freeze({
  A: '#0039A6',
  C: '#0039A6',
  E: '#0039A6',
  B: '#FF6319',
  D: '#FF6319',
  F: '#FF6319',
  M: '#FF6319',
  G: '#6CBE45',
  J: '#996633',
  Z: '#996633',
  L: '#A7A9AC',
  N: '#FCCC0A',
  Q: '#FCCC0A',
  R: '#FCCC0A',
  W: '#FCCC0A',
  S: '#808183',
  1: '#EE352E',
  2: '#EE352E',
  3: '#EE352E',
  4: '#00933C',
  5: '#00933C',
  6: '#00933C',
  7: '#B933AD',
});

function normalizeRouteId(route) {
  const normalizedRoute = String(route ?? '').trim().toUpperCase();

  return normalizedRoute || 'A';
}

function formatArrivalTime(time) {
  const numericTime = Number(time);

  if (Number.isFinite(numericTime)) {
    return numericTime <= 0 ? 'Now' : `${numericTime} min`;
  }

  return time || '--';
}

function normalizeArrivals(arrivals = [], directionKey) {
  return arrivals.map((arrival, index) => {
    const route = normalizeRouteId(arrival?.route);
    const station = String(arrival?.station ?? DEFAULT_STATION_NAME).trim();
    const direction = String(
      arrival?.direction ?? (directionKey === 'uptown' ? 'Northbound' : 'Southbound')
    ).trim();
    const time = String(arrival?.time ?? '').trim();

    return {
      id: `${directionKey}-${route}-${time}-${index}`,
      route,
      time,
      station,
      direction,
    };
  });
}

function parseArrivalsPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.arrivals)) {
    return payload.arrivals;
  }

  if (Array.isArray(payload?.data?.arrivals)) {
    return payload.data.arrivals;
  }

  return [];
}

function logFetchDebug(platformId, details) {
  if (!DEBUG_FETCH) {
    return;
  }

  console.groupCollapsed(`[Commuter Eye] ${platformId} arrivals fetch`);
  console.log(details);
  console.groupEnd();
}

function getFetchErrorMessage(error) {
  if (error?.name === 'AbortError') {
    return null;
  }

  if (error instanceof TypeError) {
    return 'Unable to load arrivals. The Render API response is missing browser CORS headers for this Glide embed.';
  }

  return 'Unable to refresh arrivals. Showing latest available times.';
}

async function fetchArrivals(platformId, signal) {
  const requestUrl = `${API_URL}?platformId=${encodeURIComponent(platformId)}`;
  const response = await fetch(requestUrl, {
    cache: 'no-store',
    mode: 'cors',
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';

  logFetchDebug(platformId, {
    contentType,
    ok: response.ok,
    status: response.status,
    url: requestUrl,
  });

  if (!response.ok) {
    throw new Error(`Arrivals request failed with ${response.status}`);
  }

  const payload = await response.json();
  const arrivals = parseArrivalsPayload(payload);

  logFetchDebug(platformId, {
    arrivalCount: arrivals.length,
    payload,
    shape: Array.isArray(payload)
      ? 'array'
      : Array.isArray(payload?.arrivals)
        ? 'object.arrivals'
        : Array.isArray(payload?.data?.arrivals)
          ? 'object.data.arrivals'
          : 'unknown',
  });

  return arrivals;
}

function usePullToRefresh(onRefresh, disabled) {
  const [pullDistance, setPullDistance] = useState(0);
  const startYRef = useRef(null);
  const isTrackingRef = useRef(false);

  const onTouchStart = useCallback((event) => {
    if (disabled || window.scrollY > 0) {
      return;
    }

    startYRef.current = event.touches[0]?.clientY ?? null;
    isTrackingRef.current = startYRef.current !== null;
  }, [disabled]);

  const onTouchMove = useCallback((event) => {
    if (!isTrackingRef.current || startYRef.current === null || window.scrollY > 0) {
      return;
    }

    const currentY = event.touches[0]?.clientY ?? startYRef.current;
    const distance = Math.max(0, currentY - startYRef.current);

    if (distance > 0) {
      setPullDistance(Math.min(distance * 0.52, 86));
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!isTrackingRef.current) {
      return;
    }

    if (pullDistance >= PULL_THRESHOLD) {
      onRefresh();
    }

    setPullDistance(0);
    startYRef.current = null;
    isTrackingRef.current = false;
  }, [onRefresh, pullDistance]);

  return {
    pullDistance,
    touchHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchCancel: onTouchEnd,
      onTouchEnd,
    },
  };
}

function ArrivalsEmbed() {
  const [arrivalsByDirection, setArrivalsByDirection] = useState({
    uptown: [],
    downtown: [],
  });
  const [stationName, setStationName] = useState(DEFAULT_STATION_NAME);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState(null);
  const abortControllerRef = useRef(null);

  const heroRoute = useMemo(() => {
    const firstArrival = arrivalsByDirection.uptown[0] ?? arrivalsByDirection.downtown[0];

    return firstArrival?.route ?? 'A';
  }, [arrivalsByDirection]);

  const loadArrivals = useCallback(async (showRefreshIndicator = false) => {
    abortControllerRef.current?.abort();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (showRefreshIndicator) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const [uptownArrivals, downtownArrivals] = await Promise.all([
        fetchArrivals(PLATFORM_IDS.uptown, controller.signal),
        fetchArrivals(PLATFORM_IDS.downtown, controller.signal),
      ]);
      const nextArrivals = {
        uptown: normalizeArrivals(uptownArrivals, 'uptown'),
        downtown: normalizeArrivals(downtownArrivals, 'downtown'),
      };
      const firstStation =
        nextArrivals.uptown[0]?.station ?? nextArrivals.downtown[0]?.station ?? DEFAULT_STATION_NAME;

      setArrivalsByDirection(nextArrivals);
      setStationName(firstStation);
      setLastUpdated(new Date());
      setErrorMessage(null);
    } catch (error) {
      const nextErrorMessage = getFetchErrorMessage(error);

      if (nextErrorMessage) {
        if (DEBUG_FETCH) {
          console.error('[Commuter Eye] arrivals fetch failed', error);
        }

        setErrorMessage(nextErrorMessage);
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }

      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadArrivals();

    const interval = window.setInterval(() => {
      loadArrivals(true);
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      abortControllerRef.current?.abort();
    };
  }, [loadArrivals]);

  const { pullDistance, touchHandlers } = usePullToRefresh(
    () => loadArrivals(true),
    isLoading || isRefreshing
  );

  const updatedLabel = lastUpdated
    ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : 'Loading arrivals';

  return h(
    'main',
    {
      className: 'embed-shell',
      style: { '--pull-distance': `${pullDistance}px` },
      ...touchHandlers,
    },
    h('div', { className: 'pull-indicator', 'aria-hidden': 'true' }, isRefreshing ? 'Refreshing' : 'Release to refresh'),
    h(
      'section',
      { className: 'station-hero', 'aria-label': `${stationName} arrivals` },
      h(RouteBullet, { route: heroRoute, size: 'large' }),
      h(
        'div',
        { className: 'station-copy' },
        h('h1', null, stationName)
      )
    ),
    h(
      'div',
      { className: 'status-row' },
      h('span', null, updatedLabel),
      isRefreshing ? h('span', { className: 'spinner', 'aria-label': 'Refreshing arrivals' }) : null
    ),
    errorMessage ? h('p', { className: 'error-message' }, errorMessage) : null,
    isLoading
      ? h(
          'section',
          { className: 'loading-card', 'aria-live': 'polite' },
          h('span', { className: 'spinner' }),
          h('span', null, 'Finding the next trains...')
        )
      : h(
          React.Fragment,
          null,
          h(ArrivalSection, {
            arrivals: arrivalsByDirection.uptown,
            directionKey: 'uptown',
            onRefresh: () => loadArrivals(true),
          }),
          h(ArrivalSection, {
            arrivals: arrivalsByDirection.downtown,
            directionKey: 'downtown',
            onRefresh: () => loadArrivals(true),
          })
        )
  );
}

function ArrivalSection({ arrivals, directionKey, onRefresh }) {
  return h(
    'section',
    { className: 'arrival-section', 'aria-labelledby': `${directionKey}-heading` },
    h(
      'div',
      { className: 'section-heading' },
      h('h2', { id: `${directionKey}-heading` }, DIRECTION_LABELS[directionKey]),
      h('span', null, PLATFORM_IDS[directionKey])
    ),
    arrivals.length > 0
      ? h(
          'div',
          { className: 'arrival-group' },
          arrivals.map((arrival, index) =>
            h(ArrivalRow, {
              arrival,
              key: arrival.id,
              showSeparator: index < arrivals.length - 1,
            })
          )
        )
      : h(
          'button',
          { className: 'empty-card', onClick: onRefresh, type: 'button' },
          h('strong', null, 'No arrivals posted'),
          h('span', null, 'Tap to check again.')
        )
  );
}

function ArrivalRow({ arrival, showSeparator }) {
  return h(
    'article',
    { className: showSeparator ? 'arrival-row with-separator' : 'arrival-row' },
    h(RouteBullet, { route: arrival.route, size: 'medium' }),
    h(
      'div',
      { className: 'arrival-copy' },
      h('h3', null, arrival.direction),
      h('p', null, arrival.station)
    ),
    h('time', { className: 'arrival-time' }, formatArrivalTime(arrival.time))
  );
}

function RouteBullet({ route, size }) {
  const normalizedRoute = normalizeRouteId(route);
  const assetSource = BULLET_ASSETS[normalizedRoute];
  const [didImageFail, setDidImageFail] = useState(false);

  useEffect(() => {
    setDidImageFail(false);
  }, [assetSource, normalizedRoute]);

  const className = size === 'large' ? 'route-bullet large' : 'route-bullet';

  if (!assetSource || didImageFail) {
    const backgroundColor = FALLBACK_COLORS[normalizedRoute] ?? '#0B2348';
    const color = ['N', 'Q', 'R', 'W'].includes(normalizedRoute) ? '#111111' : '#FFFFFF';

    return h(
      'span',
      {
        'aria-label': `${normalizedRoute} train`,
        className: `${className} fallback`,
        style: { backgroundColor, color },
      },
      normalizedRoute
    );
  }

  return h('img', {
    alt: `${normalizedRoute} train`,
    className,
    decoding: 'async',
    draggable: 'false',
    onError: () => setDidImageFail(true),
    src: assetSource,
  });
}

createRoot(document.getElementById('commuter-eye-arrivals')).render(h(ArrivalsEmbed));

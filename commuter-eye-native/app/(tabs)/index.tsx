import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  ImageSourcePropType,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

type DirectionKey = 'uptown' | 'downtown';

type ApiArrival = {
  platformId?: string;
  route?: string;
  time?: string | number;
  station?: string;
  direction?: string;
};

type Arrival = {
  id: string;
  route: string;
  time: string;
  station: string;
  direction: string;
};

const API_URL = 'https://glide-write-test.onrender.com/push-arrivals';
const DEFAULT_STATION_NAME = '59 St-Columbus Circle';
const PLATFORM_IDS: Record<DirectionKey, string> = {
  uptown: 'A24N',
  downtown: 'A24S',
};
const REFRESH_INTERVAL_MS = 15000;

const directionLabels: Record<DirectionKey, string> = {
  uptown: 'UPTOWN',
  downtown: 'DOWNTOWN',
};

const routeBulletAssets: Record<string, ImageSourcePropType> = {
  A: require('@/assets/images/route-bullet-a.png'),
  D: require('@/assets/images/route-bullet-d.png'),
};

const routeFallbackColors: Record<string, string> = {
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
  '1': '#EE352E',
  '2': '#EE352E',
  '3': '#EE352E',
  '4': '#00933C',
  '5': '#00933C',
  '6': '#00933C',
  '7': '#B933AD',
};

const normalizeRouteId = (route?: string | number | null) => {
  const normalizedRoute = String(route ?? '').trim().toUpperCase();

  return normalizedRoute || 'A';
};

const getRouteBulletAsset = (route: string) => routeBulletAssets[normalizeRouteId(route)];
const getFallbackRouteColor = (route: string) =>
  routeFallbackColors[normalizeRouteId(route)] ?? '#0B2348';
const getFallbackRouteTextColor = (route: string) =>
  ['N', 'Q', 'R', 'W'].includes(normalizeRouteId(route)) ? '#111111' : '#FFFFFF';

const formatArrivalTime = (time: string) => {
  const numericTime = Number(time);

  if (Number.isFinite(numericTime)) {
    return numericTime <= 0 ? 'Now' : `${numericTime} min`;
  }

  return time;
};

const normalizeArrivals = (arrivals: ApiArrival[] = [], directionKey: DirectionKey): Arrival[] =>
  arrivals.map((arrival, index) => {
    const route = normalizeRouteId(arrival.route);
    const station = String(arrival.station ?? DEFAULT_STATION_NAME).trim();
    const direction = String(
      arrival.direction ?? (directionKey === 'uptown' ? 'Northbound' : 'Southbound')
    ).trim();
    const time = String(arrival.time ?? '').trim();

    return {
      id: `${directionKey}-${route}-${time}-${index}`,
      route,
      time,
      station,
      direction,
    };
  });

async function fetchArrivals(platformId: string, signal?: AbortSignal): Promise<ApiArrival[]> {
  const response = await fetch(`${API_URL}?platformId=${platformId}`, { signal });

  if (!response.ok) {
    throw new Error(`Arrivals request failed with ${response.status}`);
  }

  const payload = await response.json();

  return Array.isArray(payload?.arrivals) ? payload.arrivals : [];
}

export default function HomeScreen() {
  const [arrivalsByDirection, setArrivalsByDirection] = useState<Record<DirectionKey, Arrival[]>>({
    uptown: [],
    downtown: [],
  });
  const [stationName, setStationName] = useState(DEFAULT_STATION_NAME);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }

      setErrorMessage('Unable to refresh arrivals. Showing the latest available times.');
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

    const interval = setInterval(() => {
      loadArrivals(true);
    }, REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(interval);
      abortControllerRef.current?.abort();
    };
  }, [loadArrivals]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.brand}>Commuter Eye</Text>
        <View style={styles.stationRow}>
          <RouteBullet route={heroRoute} size="large" />
          <View style={styles.stationCopy}>
            <Text style={styles.stationName}>{stationName}</Text>
            <Text style={styles.stationMeta}>IND Eighth Avenue Line</Text>
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            tintColor="#0B2348"
            onRefresh={() => loadArrivals(true)}
          />
        }
        showsVerticalScrollIndicator={false}>
        <View style={styles.statusRow}>
          <Text style={styles.updatedText}>
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit',
            })}` : 'Loading arrivals'}
          </Text>
          {isRefreshing ? <ActivityIndicator color="#0B2348" size="small" /> : null}
        </View>

        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

        {isLoading ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#0B2348" />
            <Text style={styles.loadingText}>Finding the next trains...</Text>
          </View>
        ) : (
          <>
            <ArrivalSection
              arrivals={arrivalsByDirection.uptown}
              directionKey="uptown"
              onRefresh={() => loadArrivals(true)}
            />
            <ArrivalSection
              arrivals={arrivalsByDirection.downtown}
              directionKey="downtown"
              onRefresh={() => loadArrivals(true)}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ArrivalSection({
  arrivals,
  directionKey,
  onRefresh,
}: {
  arrivals: Arrival[];
  directionKey: DirectionKey;
  onRefresh: () => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{directionLabels[directionKey]}</Text>
        <Text style={styles.platformText}>{PLATFORM_IDS[directionKey]}</Text>
      </View>

      {arrivals.length > 0 ? (
        <View style={styles.sectionCard}>
          {arrivals.map((arrival, index) => (
            <ArrivalCard
              key={arrival.id}
              arrival={arrival}
              showSeparator={index < arrivals.length - 1}
            />
          ))}
        </View>
      ) : (
        <Pressable style={styles.emptyCard} onPress={onRefresh}>
          <Text style={styles.emptyTitle}>No arrivals posted</Text>
          <Text style={styles.emptyBody}>Tap to check again.</Text>
        </Pressable>
      )}
    </View>
  );
}

function ArrivalCard({ arrival, showSeparator }: { arrival: Arrival; showSeparator: boolean }) {
  return (
    <View>
      <View style={styles.arrivalCard}>
        <View style={styles.arrivalLeft}>
          <RouteBullet route={arrival.route} size="medium" />
          <View style={styles.arrivalCopy}>
            <Text style={styles.arrivalDirection}>{arrival.direction}</Text>
            <Text style={styles.arrivalStation} numberOfLines={1}>
              {arrival.station}
            </Text>
          </View>
        </View>
        <Text style={styles.arrivalTime}>{formatArrivalTime(arrival.time)}</Text>
      </View>
      {showSeparator ? <View style={styles.arrivalSeparator} /> : null}
    </View>
  );
}

function RouteBullet({ route, size }: { route: string; size: 'large' | 'medium' }) {
  const isLarge = size === 'large';
  const bulletSize = isLarge ? 68 : 44;
  const normalizedRoute = normalizeRouteId(route);
  const assetSource = getRouteBulletAsset(normalizedRoute);
  const [didImageFail, setDidImageFail] = useState(false);

  useEffect(() => {
    setDidImageFail(false);
  }, [assetSource, normalizedRoute]);

  if (!assetSource || didImageFail) {
    return (
      <View
        style={[
          styles.routeBulletFallback,
          {
            backgroundColor: getFallbackRouteColor(normalizedRoute),
            borderRadius: bulletSize / 2,
            height: bulletSize,
            width: bulletSize,
          },
        ]}>
        <Text
          style={[
            styles.routeBulletFallbackText,
            {
              color: getFallbackRouteTextColor(normalizedRoute),
              fontSize: isLarge ? 34 : 22,
            },
          ]}>
          {normalizedRoute}
        </Text>
      </View>
    );
  }

  return (
    <Image
      accessibilityIgnoresInvertColors
      accessibilityLabel={`${normalizedRoute} train`}
      fadeDuration={0}
      onError={() => setDidImageFail(true)}
      resizeMethod="resize"
      resizeMode="contain"
      source={assetSource}
      style={[
        styles.routeBulletImage,
        {
          height: bulletSize,
          width: bulletSize,
        },
      ]}
    />
  );
}

const cardShadow = Platform.select({
  ios: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.035,
    shadowRadius: 4,
  },
  default: {
    elevation: 1,
  },
});

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    backgroundColor: '#090D2E',
    paddingHorizontal: 21,
    paddingBottom: 30,
    paddingTop: 17,
  },
  brand: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0,
    marginBottom: 30,
  },
  stationRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 18,
  },
  stationCopy: {
    flex: 1,
  },
  stationName: {
    color: '#FFFFFF',
    fontSize: 29,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 35,
  },
  stationMeta: {
    color: '#D6D9E8',
    fontSize: 15,
    fontWeight: '500',
    marginTop: 7,
  },
  content: {
    backgroundColor: '#FFFFFF',
    paddingBottom: 36,
    paddingHorizontal: 18,
    paddingTop: 16,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 22,
  },
  updatedText: {
    color: '#7A7A7A',
    fontSize: 14,
    fontWeight: '500',
  },
  errorText: {
    color: '#9F1C20',
    fontSize: 14,
    fontWeight: '500',
    marginTop: 12,
  },
  loadingCard: {
    ...cardShadow,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E9E9E9',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    marginTop: 20,
    padding: 26,
  },
  loadingText: {
    color: '#111111',
    fontSize: 16,
    fontWeight: '600',
  },
  section: {
    marginTop: 24,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  sectionTitle: {
    color: '#3F50D6',
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  platformText: {
    color: '#8A8A8A',
    fontSize: 13,
    fontWeight: '600',
  },
  sectionCard: {
    ...cardShadow,
    backgroundColor: '#FFFFFF',
    borderColor: '#E9E9E9',
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  arrivalCard: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 86,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  arrivalLeft: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 14,
    paddingRight: 16,
  },
  arrivalCopy: {
    flex: 1,
  },
  arrivalDirection: {
    color: '#111111',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0,
  },
  arrivalStation: {
    color: '#777777',
    fontSize: 15,
    fontWeight: '400',
    marginTop: 4,
  },
  arrivalTime: {
    color: '#000000',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0,
  },
  arrivalSeparator: {
    backgroundColor: '#ECECEC',
    height: StyleSheet.hairlineWidth,
    marginLeft: 74,
  },
  routeBulletImage: {
    backgroundColor: 'transparent',
  },
  routeBulletFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeBulletFallbackText: {
    fontWeight: '900',
    letterSpacing: 0,
  },
  emptyCard: {
    ...cardShadow,
    backgroundColor: '#FFFFFF',
    borderColor: '#E9E9E9',
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
  },
  emptyTitle: {
    color: '#111111',
    fontSize: 17,
    fontWeight: '700',
  },
  emptyBody: {
    color: '#777777',
    fontSize: 15,
    fontWeight: '400',
    marginTop: 6,
  },
});

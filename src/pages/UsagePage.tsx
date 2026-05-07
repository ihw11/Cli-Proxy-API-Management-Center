import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Select } from '@/components/ui/Select';
import { IconChartLine, IconKey, IconRefreshCw, IconSidebarUsage } from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import {
  isUsageServiceId,
  normalizeUsageServiceBase,
  usageServiceApi,
  type UsageEventsResponse,
  type UsageIdentityStat,
  type UsageIdentitiesResponse,
  type UsageOverviewResponse,
  type UsageRangePreset,
  type UsageWindowParams,
} from '@/services/api/usageService';
import { useAuthStore, useUsageServiceStore } from '@/stores';
import { detectApiBaseFromLocation } from '@/utils/connection';
import { formatCompactNumber, formatDurationMs, formatUsd } from '@/utils/usage';
import styles from './UsagePage.module.scss';

type UsageTab = 'overview' | 'credentials' | 'events';

const RANGE_OPTIONS: Array<{ value: UsageRangePreset; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' },
];

const RESULT_OPTIONS = [
  { value: '', label: 'All results' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
] as const;

const TAB_OPTIONS: Array<{ key: UsageTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'credentials', label: 'Credentials' },
  { key: 'events', label: 'Events' },
];

const IDENTITY_PAGE_SIZE = 12;
const EVENTS_PAGE_SIZE = 20;
const CHART_WIDTH = 560;
const CHART_HEIGHT = 190;
const CHART_PADDING = 16;

function safePercent(value: number): string {
  const normalized = Number.isFinite(value) ? value : 0;
  return `${(normalized * 100).toFixed(1)}%`;
}

function formatDateTime(value: string | number | undefined, locale: string): string {
  if (value === undefined) {
    return '--';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString(locale);
}

function formatRelativeShare(value: number, total: number): string {
  if (!total || total <= 0) {
    return '0.0%';
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

function normalizeDateTimeInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function buildWindowParams(
  range: UsageRangePreset,
  customStart: string,
  customEnd: string
): UsageWindowParams {
  if (range !== 'custom') {
    return { range };
  }
  return {
    range: 'custom',
    start: normalizeDateTimeInput(customStart),
    end: normalizeDateTimeInput(customEnd),
  };
}

function buildChartPaths(values: number[]): { line: string; area: string } {
  if (values.length === 0) {
    return { line: '', area: '' };
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const usableWidth = CHART_WIDTH - CHART_PADDING * 2;
  const usableHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const stepX = values.length > 1 ? usableWidth / (values.length - 1) : 0;
  const range = max - min || 1;

  const points = values.map((value, index) => {
    const x = CHART_PADDING + stepX * index;
    const y = CHART_HEIGHT - CHART_PADDING - ((value - min) / range) * usableHeight;
    return { x, y };
  });

  const line = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = [
    `${points[0].x},${CHART_HEIGHT - CHART_PADDING}`,
    ...points.map((point) => `${point.x},${point.y}`),
    `${points[points.length - 1].x},${CHART_HEIGHT - CHART_PADDING}`,
  ].join(' ');

  return { line, area };
}

function StatCard({
  label,
  value,
  meta,
}: {
  label: string;
  value: string;
  meta: string;
}) {
  return (
    <Card className={styles.statCard}>
      <span className={styles.statLabel}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      <span className={styles.statMeta}>{meta}</span>
    </Card>
  );
}

function ChartCard({
  title,
  subtitle,
  values,
  labels,
  accentClassName,
}: {
  title: string;
  subtitle: string;
  values: number[];
  labels: string[];
  accentClassName?: string;
}) {
  const { line, area } = useMemo(() => buildChartPaths(values), [values]);
  const latestValue = values.length > 0 ? values[values.length - 1] : 0;
  const maxValue = values.length > 0 ? Math.max(...values) : 0;

  return (
    <Card className={styles.chartCard}>
      <div className={styles.chartHeader}>
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className={styles.chartStats}>
          <span>Now {formatCompactNumber(latestValue)}</span>
          <span>Peak {formatCompactNumber(maxValue)}</span>
        </div>
      </div>

      {values.length > 0 ? (
        <div className={styles.chartWrap}>
          <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className={styles.chart} role="img">
            <defs>
              <linearGradient id={`usage-chart-${title.replace(/\s+/g, '-').toLowerCase()}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <polyline
              points={area}
              className={[styles.chartArea, accentClassName].filter(Boolean).join(' ')}
              fill={`url(#usage-chart-${title.replace(/\s+/g, '-').toLowerCase()})`}
              stroke="none"
            />
            <polyline
              points={line}
              className={[styles.chartLine, accentClassName].filter(Boolean).join(' ')}
              fill="none"
            />
          </svg>
          <div className={styles.chartAxis}>
            <span>{labels[0] ?? '--'}</span>
            <span>{labels[labels.length - 1] ?? '--'}</span>
          </div>
        </div>
      ) : (
        <div className={styles.emptyBlock}>No series data for the selected range.</div>
      )}
    </Card>
  );
}

function Pagination({
  total,
  page,
  pageSize,
  onPageChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className={styles.pagination}>
      <span>
        {total === 0 ? 'No items' : `${start}-${end} of ${total}`}
      </span>
      <div className={styles.paginationButtons}>
        <Button variant="secondary" size="sm" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          Previous
        </Button>
        <span>
          Page {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function UsagePage() {
  const { i18n } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const usageServiceEnabled = useUsageServiceStore((state) => state.enabled);
  const usageServiceBase = useUsageServiceStore((state) => state.serviceBase);

  const [activeTab, setActiveTab] = useState<UsageTab>('overview');
  const [range, setRange] = useState<UsageRangePreset>('30d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [identitySearch, setIdentitySearch] = useState('');
  const [identityPage, setIdentityPage] = useState(1);
  const [eventSource, setEventSource] = useState('');
  const [eventModel, setEventModel] = useState('');
  const [eventResult, setEventResult] = useState('');
  const [eventPage, setEventPage] = useState(1);
  const [resolvedBase, setResolvedBase] = useState('');
  const [overview, setOverview] = useState<UsageOverviewResponse | null>(null);
  const [identities, setIdentities] = useState<UsageIdentitiesResponse | null>(null);
  const [events, setEvents] = useState<UsageEventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);

  const deferredIdentitySearch = useDeferredValue(identitySearch);
  const deferredEventSource = useDeferredValue(eventSource);
  const deferredEventModel = useDeferredValue(eventModel);
  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const customRangeReady = range !== 'custom' || (customStart.trim() !== '' && customEnd.trim() !== '');

  useEffect(() => {
    setIdentityPage(1);
  }, [deferredIdentitySearch, range, customEnd, customStart]);

  useEffect(() => {
    setEventPage(1);
  }, [deferredEventModel, deferredEventSource, eventResult, range, customEnd, customStart]);

  useEffect(() => {
    if (usageServiceEnabled && usageServiceBase) {
      setResolvedBase(usageServiceBase);
      return;
    }
    setResolvedBase('');
  }, [apiBase, usageServiceBase, usageServiceEnabled]);

  const resolveServiceBase = useCallback(async (): Promise<string> => {
    if (usageServiceEnabled && usageServiceBase) {
      return usageServiceBase;
    }
    if (resolvedBase) {
      return resolvedBase;
    }

    const candidates = Array.from(
      new Set(
        [apiBase, detectApiBaseFromLocation()]
          .map((value) => normalizeUsageServiceBase(value || ''))
          .filter(Boolean)
      )
    );

    for (const candidate of candidates) {
      try {
        const info = await usageServiceApi.getInfo(candidate);
        if (isUsageServiceId(info.service)) {
          setResolvedBase(candidate);
          return candidate;
        }
      } catch {
        // Ignore non-usage-service endpoints.
      }
    }

    return '';
  }, [apiBase, resolvedBase, usageServiceBase, usageServiceEnabled]);

  const loadUsageData = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
      return;
    }
    if (!customRangeReady) {
      setLoading(false);
      setError('');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const serviceBase = await resolveServiceBase();
      if (!serviceBase) {
        throw new Error('Usage service is not configured. Open System to connect it first.');
      }

      const windowParams = buildWindowParams(range, customStart, customEnd);
      const [nextOverview, nextIdentities, nextEvents] = await Promise.all([
        usageServiceApi.getUsageOverview(serviceBase, windowParams, managementKey),
        usageServiceApi.getUsageIdentities(
          serviceBase,
          {
            ...windowParams,
            q: deferredIdentitySearch,
            limit: IDENTITY_PAGE_SIZE,
            offset: (identityPage - 1) * IDENTITY_PAGE_SIZE,
          },
          managementKey
        ),
        usageServiceApi.getUsageEvents(
          serviceBase,
          {
            ...windowParams,
            source: deferredEventSource,
            model: deferredEventModel,
            result: eventResult as 'success' | 'failed' | '',
            page: eventPage,
            pageSize: EVENTS_PAGE_SIZE,
          },
          managementKey
        ),
      ]);

      setOverview(nextOverview);
      setIdentities(nextIdentities);
      setEvents(nextEvents);
      setLastRefreshedAt(new Date());
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message || 'Failed to load usage data.');
    } finally {
      setLoading(false);
    }
  }, [
    connectionStatus,
    customEnd,
    customRangeReady,
    customStart,
    deferredEventModel,
    deferredEventSource,
    deferredIdentitySearch,
    eventPage,
    eventResult,
    identityPage,
    managementKey,
    range,
    resolveServiceBase,
  ]);

  useEffect(() => {
    void loadUsageData();
  }, [loadUsageData]);

  useHeaderRefresh(loadUsageData, connectionStatus === 'connected');

  const requestSeriesValues = useMemo(
    () => (overview?.series ?? []).map((item) => item.requests),
    [overview?.series]
  );
  const tokenSeriesValues = useMemo(
    () => (overview?.series ?? []).map((item) => item.totalTokens),
    [overview?.series]
  );
  const seriesLabels = useMemo(
    () => (overview?.series ?? []).map((item) => formatDateTime(item.timestamp, locale ?? 'en-US')),
    [locale, overview?.series]
  );

  const tokenMix = useMemo(
    () => [
      {
        label: 'Input',
        value: overview?.inputTokens ?? 0,
        accentClassName: styles.mixInput,
      },
      {
        label: 'Output',
        value: overview?.outputTokens ?? 0,
        accentClassName: styles.mixOutput,
      },
      {
        label: 'Cached',
        value: overview?.cachedTokens ?? 0,
        accentClassName: styles.mixCached,
      },
      {
        label: 'Reasoning',
        value: overview?.reasoningTokens ?? 0,
        accentClassName: styles.mixReasoning,
      },
    ],
    [overview?.cachedTokens, overview?.inputTokens, overview?.outputTokens, overview?.reasoningTokens]
  );

  const topIdentityMaxRequests = useMemo(
    () => Math.max(...(overview?.topIdentities ?? []).map((item) => item.requests), 0),
    [overview?.topIdentities]
  );

  const identityTotalPages = Math.max(
    1,
    Math.ceil((identities?.total ?? 0) / IDENTITY_PAGE_SIZE)
  );
  const eventsTotalPages = Math.max(1, Math.ceil((events?.total ?? 0) / EVENTS_PAGE_SIZE));

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>User key analytics</span>
          <h1 className={styles.title}>Usage</h1>
          <p className={styles.subtitle}>
            Overview, per-key usage, and raw request events for user API keys.
          </p>
        </div>

        <div className={styles.heroMeta}>
          <div className={styles.heroStat}>
            <IconSidebarUsage size={18} />
            <span>{overview ? `${formatCompactNumber(overview.requests)} requests` : 'No data yet'}</span>
          </div>
          <div className={styles.heroStat}>
            <IconKey size={18} />
            <span>{identities ? `${identities.total} active keys` : 'Key stats pending'}</span>
          </div>
          <div className={styles.heroActions}>
            <Link to="/api-keys" className={styles.linkButton}>
              Open API keys
            </Link>
            <Button variant="secondary" size="sm" onClick={() => void loadUsageData()} loading={loading}>
              <IconRefreshCw size={15} />
              <span>Refresh</span>
            </Button>
          </div>
        </div>
      </section>

      <Card className={styles.toolbarCard}>
        <div className={styles.toolbarTop}>
          <div className={styles.segmentedControl}>
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.segmentButton} ${range === option.value ? styles.segmentButtonActive : ''}`}
                onClick={() => setRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className={styles.statusRow}>
            <span>{lastRefreshedAt ? `Last sync: ${lastRefreshedAt.toLocaleTimeString(locale)}` : 'Not synced yet'}</span>
          </div>
        </div>

        {range === 'custom' ? (
          <div className={styles.customRangeGrid}>
            <Input
              type="datetime-local"
              label="Start"
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
            />
            <Input
              type="datetime-local"
              label="End"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </div>
        ) : null}

        {!customRangeReady ? (
          <div className={styles.notice}>Choose both start and end to load a custom range.</div>
        ) : null}

        {error ? <div className={styles.errorBox}>{error}</div> : null}
      </Card>

      <div className={styles.tabs}>
        {TAB_OPTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`${styles.tabButton} ${activeTab === tab.key ? styles.tabButtonActive : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loading && !overview && !identities && !events ? (
        <div className={styles.loadingState}>
          <LoadingSpinner size={28} />
          <span>Loading usage data…</span>
        </div>
      ) : null}

      {activeTab === 'overview' ? (
        <>
          <section className={styles.statsGrid}>
            <StatCard
              label="Requests"
              value={formatCompactNumber(overview?.requests ?? 0)}
              meta={`${formatCompactNumber(overview?.successCount ?? 0)} success · ${formatCompactNumber(overview?.failureCount ?? 0)} failed`}
            />
            <StatCard
              label="Total tokens"
              value={formatCompactNumber(overview?.totalTokens ?? 0)}
              meta={`Input ${formatCompactNumber(overview?.inputTokens ?? 0)} · Output ${formatCompactNumber(overview?.outputTokens ?? 0)}`}
            />
            <StatCard
              label="Success rate"
              value={safePercent(overview?.successRate ?? 0)}
              meta={`${formatCompactNumber(overview?.failureCount ?? 0)} failed calls`}
            />
            <StatCard
              label="Estimated cost"
              value={formatUsd(overview?.estimatedCost ?? 0)}
              meta={`${identities?.total ?? 0} identities in range`}
            />
          </section>

          <section className={styles.chartGrid}>
            <ChartCard
              title="Requests trend"
              subtitle="Aggregated request volume across the selected range."
              values={requestSeriesValues}
              labels={seriesLabels}
            />
            <ChartCard
              title="Token trend"
              subtitle="Total token volume by bucket."
              values={tokenSeriesValues}
              labels={seriesLabels}
              accentClassName={styles.chartAccentAlt}
            />
          </section>

          <section className={styles.overviewGrid}>
            <Card className={styles.panelCard}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>Top keys</h2>
                  <p>The most active identities in the selected window.</p>
                </div>
                <Link to="/api-keys" className={styles.inlineLink}>
                  Manage keys
                </Link>
              </div>

              {overview?.topIdentities?.length ? (
                <div className={styles.identityList}>
                  {overview.topIdentities.map((identity) => {
                    const width = topIdentityMaxRequests > 0
                      ? `${Math.max(8, (identity.requests / topIdentityMaxRequests) * 100)}%`
                      : '0%';
                    return (
                      <div key={identity.identityHash} className={styles.identityRow}>
                        <div className={styles.identityTop}>
                          <div>
                            <strong>{identity.displaySource || maskApiKey(identity.identityHash)}</strong>
                            <span>{formatCompactNumber(identity.requests)} requests</span>
                          </div>
                          <div className={styles.identityMeta}>
                            <span>{safePercent(identity.successRate)}</span>
                            <span>{formatUsd(identity.estimatedCost)}</span>
                          </div>
                        </div>
                        <div className={styles.identityBarTrack}>
                          <span className={styles.identityBarFill} style={{ width }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className={styles.emptyBlock}>No key activity was found in the selected range.</div>
              )}
            </Card>

            <Card className={styles.panelCard}>
              <div className={styles.panelHeader}>
                <div>
                  <h2>Token mix</h2>
                  <p>How the selected usage is distributed between token types.</p>
                </div>
                <IconChartLine size={18} />
              </div>

              <div className={styles.tokenMixList}>
                {tokenMix.map((item) => (
                  <div key={item.label} className={styles.tokenMixRow}>
                    <div className={styles.tokenMixTop}>
                      <strong>{item.label}</strong>
                      <span>
                        {formatCompactNumber(item.value)} · {formatRelativeShare(item.value, overview?.totalTokens ?? 0)}
                      </span>
                    </div>
                    <div className={styles.tokenMixTrack}>
                      <span
                        className={[styles.tokenMixFill, item.accentClassName].join(' ')}
                        style={{ width: `${overview?.totalTokens ? Math.max(6, (item.value / overview.totalTokens) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        </>
      ) : null}

      {activeTab === 'credentials' ? (
        <Card className={styles.panelCard}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Credential usage</h2>
              <p>Per-key aggregates sorted by request volume.</p>
            </div>
            <div className={styles.inlineHeaderActions}>
              <Input
                value={identitySearch}
                onChange={(event) => setIdentitySearch(event.target.value)}
                placeholder="Search key or masked source"
              />
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Requests</th>
                  <th>Success</th>
                  <th>Failure</th>
                  <th>Rate</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cached</th>
                  <th>Total</th>
                  <th>Cost</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {identities?.items?.length ? (
                  identities.items.map((identity: UsageIdentityStat) => (
                    <tr key={identity.identityHash}>
                      <td className={styles.keyCell}>{identity.displaySource || maskApiKey(identity.identityHash)}</td>
                      <td>{formatCompactNumber(identity.requests)}</td>
                      <td>{formatCompactNumber(identity.successCount)}</td>
                      <td>{formatCompactNumber(identity.failureCount)}</td>
                      <td>{safePercent(identity.successRate)}</td>
                      <td>{formatCompactNumber(identity.inputTokens)}</td>
                      <td>{formatCompactNumber(identity.outputTokens)}</td>
                      <td>{formatCompactNumber(identity.cachedTokens)}</td>
                      <td>{formatCompactNumber(identity.totalTokens)}</td>
                      <td>{formatUsd(identity.estimatedCost)}</td>
                      <td>{formatDateTime(identity.lastRequestAt, locale ?? 'en-US')}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11}>
                      <div className={styles.emptyBlock}>No identities matched the current filters.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            total={identities?.total ?? 0}
            page={Math.min(identityPage, identityTotalPages)}
            pageSize={IDENTITY_PAGE_SIZE}
            onPageChange={setIdentityPage}
          />
        </Card>
      ) : null}

      {activeTab === 'events' ? (
        <Card className={styles.panelCard}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Request events</h2>
              <p>Recent raw events from user-key traffic.</p>
            </div>
          </div>

          <div className={styles.filtersGrid}>
            <Input
              value={eventSource}
              onChange={(event) => setEventSource(event.target.value)}
              placeholder="Filter by source"
            />
            <Input
              value={eventModel}
              onChange={(event) => setEventModel(event.target.value)}
              placeholder="Filter by model"
            />
            <Select
              value={eventResult}
              options={RESULT_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
              onChange={setEventResult}
              ariaLabel="Filter by result"
            />
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source</th>
                  <th>Model</th>
                  <th>Result</th>
                  <th>Latency</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Cached</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {events?.items?.length ? (
                  events.items.map((event) => (
                    <tr key={event.id}>
                      <td>{formatDateTime(event.timestamp || event.timestampMs, locale ?? 'en-US')}</td>
                      <td className={styles.keyCell}>{event.source || '--'}</td>
                      <td>{event.model || '--'}</td>
                      <td>
                        <span className={event.failed ? styles.resultFailed : styles.resultSuccess}>
                          {event.result}
                        </span>
                      </td>
                      <td>{formatDurationMs(event.latencyMs, { locale })}</td>
                      <td>{formatCompactNumber(event.inputTokens)}</td>
                      <td>{formatCompactNumber(event.outputTokens)}</td>
                      <td>{formatCompactNumber(event.cachedTokens)}</td>
                      <td>{formatCompactNumber(event.totalTokens)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={9}>
                      <div className={styles.emptyBlock}>No events matched the current filters.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            total={events?.total ?? 0}
            page={Math.min(eventPage, eventsTotalPages)}
            pageSize={EVENTS_PAGE_SIZE}
            onPageChange={setEventPage}
          />
        </Card>
      ) : null}
    </div>
  );
}

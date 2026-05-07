import axios from 'axios';
import type { UsagePayload } from '@/features/monitoring/hooks/useUsageData';
import { normalizeApiBase } from '@/utils/connection';
import type { ModelPrice } from '@/utils/usage';

export interface UsageServiceInfo {
  service?: string;
  mode?: string;
  startedAt?: number;
}

export interface UsageServiceCollectorStatus {
  collector?: string;
  upstream?: string;
  mode?: string;
  transport?: string;
  queue?: string;
  lastConsumedAt?: number;
  lastInsertedAt?: number;
  totalInserted?: number;
  totalSkipped?: number;
  deadLetters?: number;
  lastError?: string;
}

export interface UsageServiceStatus {
  service?: string;
  dbPath?: string;
  events?: number;
  deadLetters?: number;
  collector?: UsageServiceCollectorStatus;
}

export interface UsageServiceSetupRequest {
  cpaBaseUrl: string;
  managementKey: string;
  queue?: string;
  popSide?: string;
}

export interface ModelPricesResponse {
  prices: Record<string, ModelPrice>;
}

export interface ModelPriceSyncResponse extends ModelPricesResponse {
  source?: string;
  imported: number;
  skipped: number;
}

export type UsageRangePreset = '24h' | '7d' | '30d' | 'today' | 'all' | 'custom';

export interface UsageWindowParams {
  range?: UsageRangePreset;
  start?: string | number;
  end?: string | number;
}

export interface UsageSeriesPoint {
  bucketStartMs: number;
  timestamp: string;
  requests: number;
  successCount: number;
  failureCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface UsageIdentityStat {
  identityHash: string;
  displaySource: string;
  requests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
  lastRequestAt: number;
}

export interface UsageOverviewResponse {
  fromMs: number;
  toMs: number;
  bucketSizeMs: number;
  requests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
  series: UsageSeriesPoint[];
  topIdentities: UsageIdentityStat[];
}

export interface UsageIdentitiesParams extends UsageWindowParams {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface UsageIdentitiesResponse {
  total: number;
  items: UsageIdentityStat[];
}

export interface UsageEventListItem {
  id: number;
  timestampMs: number;
  timestamp: string;
  model: string;
  source: string;
  result: 'success' | 'failed';
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  totalTokens: number;
  latencyMs?: number;
  failed: boolean;
}

export interface UsageEventsParams extends UsageWindowParams {
  source?: string;
  model?: string;
  result?: 'success' | 'failed' | '';
  page?: number;
  pageSize?: number;
  offset?: number;
}

export interface UsageEventsResponse {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  items: UsageEventListItem[];
}

const USAGE_SERVICE_TIMEOUT_MS = 15 * 1000;
export const USAGE_SERVICE_ID = 'cpa-manager';
export const LEGACY_USAGE_SERVICE_ID = 'cpa-usage-service';
export const USAGE_SERVICE_LAST_CPA_BASE_KEY = 'cpa-manager:last-cpa-base';
export const LEGACY_USAGE_SERVICE_LAST_CPA_BASE_KEY = 'cpa-usage-service:last-cpa-base';

export const isUsageServiceId = (service?: string): boolean =>
  service === USAGE_SERVICE_ID || service === LEGACY_USAGE_SERVICE_ID;

export const normalizeUsageServiceBase = (input: string): string => normalizeApiBase(input);

const buildUrl = (base: string, path: string): string => {
  const normalized = normalizeUsageServiceBase(base).replace(/\/+$/, '');
  return `${normalized}${path}`;
};

const authHeaders = (managementKey?: string) =>
  managementKey ? { Authorization: `Bearer ${managementKey}` } : undefined;

const appendQueryValue = (params: URLSearchParams, key: string, value: string | number | undefined) => {
  if (value === undefined) {
    return;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return;
  }
  params.set(key, normalized);
};

const buildWindowQuery = (params: UsageWindowParams = {}): Record<string, string | number | undefined> => ({
  range: params.range,
  start: params.start,
  end: params.end,
});

const buildQueryUrl = (
  base: string,
  path: string,
  query: Record<string, string | number | undefined>
): string => {
  const search = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => appendQueryValue(search, key, value));
  const queryString = search.toString();
  return queryString ? `${buildUrl(base, path)}?${queryString}` : buildUrl(base, path);
};

export const usageServiceApi = {
  getInfo: async (base: string): Promise<UsageServiceInfo> => {
    const response = await axios.get<UsageServiceInfo>(buildUrl(base, '/usage-service/info'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
    });
    return response.data;
  },

  setup: async (base: string, payload: UsageServiceSetupRequest): Promise<void> => {
    await axios.post(buildUrl(base, '/setup'), payload, {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
    });
  },

  getStatus: async (base: string, managementKey?: string): Promise<UsageServiceStatus> => {
    const response = await axios.get<UsageServiceStatus>(buildUrl(base, '/status'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
      headers: authHeaders(managementKey),
    });
    return response.data;
  },

  getUsage: async (base: string, managementKey?: string): Promise<UsagePayload> => {
    const response = await axios.get<UsagePayload>(buildUrl(base, '/v0/management/usage'), {
      timeout: USAGE_SERVICE_TIMEOUT_MS,
      headers: authHeaders(managementKey),
    });
    return response.data;
  },

  getUsageOverview: async (
    base: string,
    params: UsageWindowParams = {},
    managementKey?: string
  ): Promise<UsageOverviewResponse> => {
    const response = await axios.get<UsageOverviewResponse>(
      buildQueryUrl(base, '/v0/management/usage/overview', buildWindowQuery(params)),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  getUsageIdentities: async (
    base: string,
    params: UsageIdentitiesParams = {},
    managementKey?: string
  ): Promise<UsageIdentitiesResponse> => {
    const response = await axios.get<UsageIdentitiesResponse>(
      buildQueryUrl(base, '/v0/management/usage/identities', {
        ...buildWindowQuery(params),
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      }),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  getUsageEvents: async (
    base: string,
    params: UsageEventsParams = {},
    managementKey?: string
  ): Promise<UsageEventsResponse> => {
    const response = await axios.get<UsageEventsResponse>(
      buildQueryUrl(base, '/v0/management/usage/events', {
        ...buildWindowQuery(params),
        source: params.source,
        model: params.model,
        result: params.result,
        page: params.page,
        page_size: params.pageSize,
        offset: params.offset,
      }),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  getModelPrices: async (
    base: string,
    managementKey?: string
  ): Promise<ModelPricesResponse> => {
    const response = await axios.get<ModelPricesResponse>(
      buildUrl(base, '/v0/management/model-prices'),
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  saveModelPrices: async (
    base: string,
    prices: Record<string, ModelPrice>,
    managementKey?: string
  ): Promise<ModelPricesResponse> => {
    const response = await axios.put<ModelPricesResponse>(
      buildUrl(base, '/v0/management/model-prices'),
      { prices },
      {
        timeout: USAGE_SERVICE_TIMEOUT_MS,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },

  syncModelPrices: async (
    base: string,
    managementKey?: string,
    models?: string[]
  ): Promise<ModelPriceSyncResponse> => {
    const response = await axios.post<ModelPriceSyncResponse>(
      buildUrl(base, '/v0/management/model-prices/sync'),
      models ? { models } : {},
      {
        timeout: 30 * 1000,
        headers: authHeaders(managementKey),
      }
    );
    return response.data;
  },
};

package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"time"
)

const tokensPerPriceUnit = 1_000_000

type UsageWindow struct {
	FromMS int64
	ToMS   int64
}

type UsageOverview struct {
	FromMS         int64               `json:"fromMs"`
	ToMS           int64               `json:"toMs"`
	BucketSizeMS   int64               `json:"bucketSizeMs"`
	Requests       int64               `json:"requests"`
	SuccessCount   int64               `json:"successCount"`
	FailureCount   int64               `json:"failureCount"`
	SuccessRate    float64             `json:"successRate"`
	InputTokens    int64               `json:"inputTokens"`
	OutputTokens   int64               `json:"outputTokens"`
	ReasoningTokens int64              `json:"reasoningTokens"`
	CachedTokens   int64               `json:"cachedTokens"`
	TotalTokens    int64               `json:"totalTokens"`
	EstimatedCost  float64             `json:"estimatedCost"`
	Series         []UsageSeriesPoint  `json:"series"`
	TopIdentities  []UsageIdentityStat `json:"topIdentities"`
}

type UsageSeriesPoint struct {
	BucketStartMS   int64   `json:"bucketStartMs"`
	Timestamp       string  `json:"timestamp"`
	Requests        int64   `json:"requests"`
	SuccessCount    int64   `json:"successCount"`
	FailureCount    int64   `json:"failureCount"`
	InputTokens     int64   `json:"inputTokens"`
	OutputTokens    int64   `json:"outputTokens"`
	ReasoningTokens int64   `json:"reasoningTokens"`
	CachedTokens    int64   `json:"cachedTokens"`
	TotalTokens     int64   `json:"totalTokens"`
	EstimatedCost   float64 `json:"estimatedCost"`
}

type UsageIdentityStat struct {
	IdentityHash    string  `json:"identityHash"`
	DisplaySource   string  `json:"displaySource"`
	Requests        int64   `json:"requests"`
	SuccessCount    int64   `json:"successCount"`
	FailureCount    int64   `json:"failureCount"`
	SuccessRate     float64 `json:"successRate"`
	InputTokens     int64   `json:"inputTokens"`
	OutputTokens    int64   `json:"outputTokens"`
	ReasoningTokens int64   `json:"reasoningTokens"`
	CachedTokens    int64   `json:"cachedTokens"`
	TotalTokens     int64   `json:"totalTokens"`
	EstimatedCost   float64 `json:"estimatedCost"`
	LastRequestAt   int64   `json:"lastRequestAt"`
}

type UsageIdentitiesResponse struct {
	Total int                 `json:"total"`
	Items []UsageIdentityStat `json:"items"`
}

type UsageEventsQuery struct {
	Window   UsageWindow
	Source   string
	Model    string
	Result   string
	Limit    int
	Offset   int
}

type UsageEventListItem struct {
	ID              int64  `json:"id"`
	TimestampMS     int64  `json:"timestampMs"`
	Timestamp       string `json:"timestamp"`
	Model           string `json:"model"`
	Source          string `json:"source"`
	Result          string `json:"result"`
	InputTokens     int64  `json:"inputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	ReasoningTokens int64  `json:"reasoningTokens"`
	CachedTokens    int64  `json:"cachedTokens"`
	TotalTokens     int64  `json:"totalTokens"`
	LatencyMS       *int64 `json:"latencyMs,omitempty"`
	Failed          bool   `json:"failed"`
}

type UsageEventsResponse struct {
	Total    int64                `json:"total"`
	Limit    int                  `json:"limit"`
	Offset   int                  `json:"offset"`
	HasMore  bool                 `json:"hasMore"`
	Items    []UsageEventListItem `json:"items"`
}

type usageOverviewTotalsRow struct {
	Requests        int64
	SuccessCount    int64
	FailureCount    int64
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
}

type usageSeriesModelRow struct {
	BucketStartMS   int64
	Model           string
	Requests        int64
	SuccessCount    int64
	FailureCount    int64
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
}

type usageIdentityModelRow struct {
	IdentityHash    string
	DisplaySource   string
	Model           string
	Requests        int64
	SuccessCount    int64
	FailureCount    int64
	InputTokens     int64
	OutputTokens    int64
	ReasoningTokens int64
	CachedTokens    int64
	TotalTokens     int64
	LastRequestAt   int64
}

type usageFilterBuilder struct {
	clauses []string
	args    []any
}

func (b *usageFilterBuilder) add(clause string, args ...any) {
	b.clauses = append(b.clauses, clause)
	b.args = append(b.args, args...)
}

func (b *usageFilterBuilder) addWindow(window UsageWindow) {
	if window.FromMS > 0 {
		b.add("timestamp_ms >= ?", window.FromMS)
	}
	if window.ToMS > 0 {
		b.add("timestamp_ms <= ?", window.ToMS)
	}
}

func (b *usageFilterBuilder) addContains(column string, value string) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return
	}
	b.add(fmt.Sprintf("lower(%s) like ?", column), "%"+strings.ToLower(trimmed)+"%")
}

func (b *usageFilterBuilder) whereClause() string {
	if len(b.clauses) == 0 {
		return ""
	}
	return " where " + strings.Join(b.clauses, " and ")
}

func (s *Store) UsageOverview(ctx context.Context, window UsageWindow) (UsageOverview, error) {
	overview := UsageOverview{
		FromMS:       window.FromMS,
		ToMS:         window.ToMS,
		BucketSizeMS: determineBucketSizeMS(window),
	}

	totals, err := s.loadUsageOverviewTotals(ctx, window)
	if err != nil {
		return UsageOverview{}, err
	}
	overview.Requests = totals.Requests
	overview.SuccessCount = totals.SuccessCount
	overview.FailureCount = totals.FailureCount
	overview.SuccessRate = successRate(totals.SuccessCount, totals.Requests)
	overview.InputTokens = totals.InputTokens
	overview.OutputTokens = totals.OutputTokens
	overview.ReasoningTokens = totals.ReasoningTokens
	overview.CachedTokens = totals.CachedTokens
	overview.TotalTokens = totals.TotalTokens

	prices, err := s.LoadModelPrices(ctx)
	if err != nil {
		return UsageOverview{}, err
	}

	seriesRows, err := s.loadUsageSeriesRows(ctx, window, overview.BucketSizeMS)
	if err != nil {
		return UsageOverview{}, err
	}
	overview.Series, overview.EstimatedCost = buildUsageSeries(seriesRows, prices)

	identityRows, err := s.loadUsageIdentityRows(ctx, window, "")
	if err != nil {
		return UsageOverview{}, err
	}
	identities := aggregateUsageIdentities(identityRows, prices)
	if len(identities) > 8 {
		identities = identities[:8]
	}
	overview.TopIdentities = identities
	if overview.EstimatedCost == 0 {
		for _, identity := range identities {
			overview.EstimatedCost += identity.EstimatedCost
		}
	}

	return overview, nil
}

func (s *Store) UsageIdentities(ctx context.Context, window UsageWindow, search string, limit int, offset int) (UsageIdentitiesResponse, error) {
	prices, err := s.LoadModelPrices(ctx)
	if err != nil {
		return UsageIdentitiesResponse{}, err
	}
	rows, err := s.loadUsageIdentityRows(ctx, window, search)
	if err != nil {
		return UsageIdentitiesResponse{}, err
	}
	items := aggregateUsageIdentities(rows, prices)
	total := len(items)
	start, end := sliceBounds(total, limit, offset)
	return UsageIdentitiesResponse{
		Total: total,
		Items: items[start:end],
	}, nil
}

func (s *Store) UsageEvents(ctx context.Context, query UsageEventsQuery) (UsageEventsResponse, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}

	filters := usageFilterBuilder{}
	filters.addWindow(query.Window)
	filters.addContains("source", query.Source)
	filters.addContains("model", query.Model)
	switch strings.ToLower(strings.TrimSpace(query.Result)) {
	case "success":
		filters.add("failed = 0")
	case "failed":
		filters.add("failed = 1")
	}

	countSQL := `select count(*) from usage_events` + filters.whereClause()
	var total int64
	if err := s.db.QueryRowContext(ctx, countSQL, filters.args...).Scan(&total); err != nil {
		return UsageEventsResponse{}, err
	}

	listSQL := `select
		id, timestamp_ms, timestamp, model, source,
		input_tokens, output_tokens, reasoning_tokens,
		case when cached_tokens > cache_tokens then cached_tokens else cache_tokens end as cached_value,
		total_tokens, latency_ms, failed
		from usage_events` + filters.whereClause() + `
		order by timestamp_ms desc, id desc
		limit ? offset ?`
	args := append(append([]any{}, filters.args...), limit, offset)
	rows, err := s.db.QueryContext(ctx, listSQL, args...)
	if err != nil {
		return UsageEventsResponse{}, err
	}
	defer rows.Close()

	items := make([]UsageEventListItem, 0, limit)
	for rows.Next() {
		var item UsageEventListItem
		var source sql.NullString
		var latency sql.NullInt64
		var failed int
		if err := rows.Scan(
			&item.ID,
			&item.TimestampMS,
			&item.Timestamp,
			&item.Model,
			&source,
			&item.InputTokens,
			&item.OutputTokens,
			&item.ReasoningTokens,
			&item.CachedTokens,
			&item.TotalTokens,
			&latency,
			&failed,
		); err != nil {
			return UsageEventsResponse{}, err
		}
		item.Source = source.String
		item.Failed = failed != 0
		if item.Failed {
			item.Result = "failed"
		} else {
			item.Result = "success"
		}
		if latency.Valid {
			value := latency.Int64
			item.LatencyMS = &value
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return UsageEventsResponse{}, err
	}

	return UsageEventsResponse{
		Total:   total,
		Limit:   limit,
		Offset:  offset,
		HasMore: int64(offset+len(items)) < total,
		Items:   items,
	}, nil
}

func (s *Store) loadUsageOverviewTotals(ctx context.Context, window UsageWindow) (usageOverviewTotalsRow, error) {
	filters := usageFilterBuilder{}
	filters.addWindow(window)
	query := `select
		count(*),
		sum(case when failed = 0 then 1 else 0 end),
		sum(case when failed != 0 then 1 else 0 end),
		coalesce(sum(input_tokens), 0),
		coalesce(sum(output_tokens), 0),
		coalesce(sum(reasoning_tokens), 0),
		coalesce(sum(case when cached_tokens > cache_tokens then cached_tokens else cache_tokens end), 0),
		coalesce(sum(total_tokens), 0)
		from usage_events` + filters.whereClause()
	var row usageOverviewTotalsRow
	err := s.db.QueryRowContext(ctx, query, filters.args...).Scan(
		&row.Requests,
		&row.SuccessCount,
		&row.FailureCount,
		&row.InputTokens,
		&row.OutputTokens,
		&row.ReasoningTokens,
		&row.CachedTokens,
		&row.TotalTokens,
	)
	return row, err
}

func (s *Store) loadUsageSeriesRows(ctx context.Context, window UsageWindow, bucketSizeMS int64) ([]usageSeriesModelRow, error) {
	if bucketSizeMS <= 0 {
		bucketSizeMS = int64(time.Hour / time.Millisecond)
	}
	filters := usageFilterBuilder{}
	filters.addWindow(window)
	query := `select
		(timestamp_ms / ?) * ? as bucket_start_ms,
		model,
		count(*),
		sum(case when failed = 0 then 1 else 0 end),
		sum(case when failed != 0 then 1 else 0 end),
		coalesce(sum(input_tokens), 0),
		coalesce(sum(output_tokens), 0),
		coalesce(sum(reasoning_tokens), 0),
		coalesce(sum(case when cached_tokens > cache_tokens then cached_tokens else cache_tokens end), 0),
		coalesce(sum(total_tokens), 0)
		from usage_events` + filters.whereClause() + `
		group by bucket_start_ms, model
		order by bucket_start_ms asc, model asc`
	args := append([]any{bucketSizeMS, bucketSizeMS}, filters.args...)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]usageSeriesModelRow, 0)
	for rows.Next() {
		var row usageSeriesModelRow
		if err := rows.Scan(
			&row.BucketStartMS,
			&row.Model,
			&row.Requests,
			&row.SuccessCount,
			&row.FailureCount,
			&row.InputTokens,
			&row.OutputTokens,
			&row.ReasoningTokens,
			&row.CachedTokens,
			&row.TotalTokens,
		); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Store) loadUsageIdentityRows(ctx context.Context, window UsageWindow, search string) ([]usageIdentityModelRow, error) {
	filters := usageFilterBuilder{}
	filters.addWindow(window)
	filters.add("coalesce(nullif(api_key_hash, ''), nullif(source_hash, '')) <> ''")
	filters.addContains("source", search)
	query := `select
		coalesce(nullif(api_key_hash, ''), nullif(source_hash, '')) as identity_hash,
		coalesce(max(nullif(source, '')), '') as display_source,
		model,
		count(*),
		sum(case when failed = 0 then 1 else 0 end),
		sum(case when failed != 0 then 1 else 0 end),
		coalesce(sum(input_tokens), 0),
		coalesce(sum(output_tokens), 0),
		coalesce(sum(reasoning_tokens), 0),
		coalesce(sum(case when cached_tokens > cache_tokens then cached_tokens else cache_tokens end), 0),
		coalesce(sum(total_tokens), 0),
		coalesce(max(timestamp_ms), 0)
		from usage_events` + filters.whereClause() + `
		group by identity_hash, model`
	rows, err := s.db.QueryContext(ctx, query, filters.args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]usageIdentityModelRow, 0)
	for rows.Next() {
		var row usageIdentityModelRow
		if err := rows.Scan(
			&row.IdentityHash,
			&row.DisplaySource,
			&row.Model,
			&row.Requests,
			&row.SuccessCount,
			&row.FailureCount,
			&row.InputTokens,
			&row.OutputTokens,
			&row.ReasoningTokens,
			&row.CachedTokens,
			&row.TotalTokens,
			&row.LastRequestAt,
		); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func buildUsageSeries(rows []usageSeriesModelRow, prices map[string]ModelPrice) ([]UsageSeriesPoint, float64) {
	if len(rows) == 0 {
		return []UsageSeriesPoint{}, 0
	}
	pointsByBucket := make(map[int64]*UsageSeriesPoint, len(rows))
	orderedBuckets := make([]int64, 0)
	totalCost := 0.0
	for _, row := range rows {
		point := pointsByBucket[row.BucketStartMS]
		if point == nil {
			point = &UsageSeriesPoint{
				BucketStartMS: row.BucketStartMS,
				Timestamp:     time.UnixMilli(row.BucketStartMS).UTC().Format(time.RFC3339),
			}
			pointsByBucket[row.BucketStartMS] = point
			orderedBuckets = append(orderedBuckets, row.BucketStartMS)
		}
		point.Requests += row.Requests
		point.SuccessCount += row.SuccessCount
		point.FailureCount += row.FailureCount
		point.InputTokens += row.InputTokens
		point.OutputTokens += row.OutputTokens
		point.ReasoningTokens += row.ReasoningTokens
		point.CachedTokens += row.CachedTokens
		point.TotalTokens += row.TotalTokens
		cost := estimateUsageCost(row.Model, row.InputTokens, row.OutputTokens, row.CachedTokens, prices)
		point.EstimatedCost += cost
		totalCost += cost
	}
	sort.Slice(orderedBuckets, func(i int, j int) bool { return orderedBuckets[i] < orderedBuckets[j] })
	points := make([]UsageSeriesPoint, 0, len(orderedBuckets))
	for _, bucket := range orderedBuckets {
		points = append(points, *pointsByBucket[bucket])
	}
	return points, totalCost
}

func aggregateUsageIdentities(rows []usageIdentityModelRow, prices map[string]ModelPrice) []UsageIdentityStat {
	if len(rows) == 0 {
		return []UsageIdentityStat{}
	}
	byIdentity := make(map[string]*UsageIdentityStat, len(rows))
	for _, row := range rows {
		identity := byIdentity[row.IdentityHash]
		if identity == nil {
			identity = &UsageIdentityStat{
				IdentityHash:  row.IdentityHash,
				DisplaySource: row.DisplaySource,
			}
			byIdentity[row.IdentityHash] = identity
		}
		if identity.DisplaySource == "" && row.DisplaySource != "" {
			identity.DisplaySource = row.DisplaySource
		}
		identity.Requests += row.Requests
		identity.SuccessCount += row.SuccessCount
		identity.FailureCount += row.FailureCount
		identity.InputTokens += row.InputTokens
		identity.OutputTokens += row.OutputTokens
		identity.ReasoningTokens += row.ReasoningTokens
		identity.CachedTokens += row.CachedTokens
		identity.TotalTokens += row.TotalTokens
		if row.LastRequestAt > identity.LastRequestAt {
			identity.LastRequestAt = row.LastRequestAt
		}
		identity.EstimatedCost += estimateUsageCost(row.Model, row.InputTokens, row.OutputTokens, row.CachedTokens, prices)
	}
	items := make([]UsageIdentityStat, 0, len(byIdentity))
	for _, identity := range byIdentity {
		identity.SuccessRate = successRate(identity.SuccessCount, identity.Requests)
		items = append(items, *identity)
	}
	sort.Slice(items, func(i int, j int) bool {
		if items[i].Requests != items[j].Requests {
			return items[i].Requests > items[j].Requests
		}
		if items[i].LastRequestAt != items[j].LastRequestAt {
			return items[i].LastRequestAt > items[j].LastRequestAt
		}
		return items[i].DisplaySource < items[j].DisplaySource
	})
	return items
}

func determineBucketSizeMS(window UsageWindow) int64 {
	span := window.ToMS - window.FromMS
	switch {
	case span <= int64(48*time.Hour/time.Millisecond):
		return int64(time.Hour / time.Millisecond)
	case span <= int64(14*24*time.Hour/time.Millisecond):
		return int64(6 * time.Hour / time.Millisecond)
	default:
		return int64(24 * time.Hour / time.Millisecond)
	}
}

func estimateUsageCost(model string, inputTokens int64, outputTokens int64, cachedTokens int64, prices map[string]ModelPrice) float64 {
	price, ok := resolveModelPrice(prices, model)
	if !ok {
		return 0
	}
	promptTokens := inputTokens - cachedTokens
	if promptTokens < 0 {
		promptTokens = 0
	}
	promptCost := (float64(promptTokens) / tokensPerPriceUnit) * price.Prompt
	cachedCost := (float64(cachedTokens) / tokensPerPriceUnit) * price.Cache
	completionCost := (float64(outputTokens) / tokensPerPriceUnit) * price.Completion
	return promptCost + cachedCost + completionCost
}

func resolveModelPrice(prices map[string]ModelPrice, model string) (ModelPrice, bool) {
	if price, ok := prices[model]; ok {
		return price, true
	}
	suffix := "/" + model
	matchedKey := ""
	var matchedPrice ModelPrice
	for key, price := range prices {
		if !strings.HasSuffix(key, suffix) {
			continue
		}
		if matchedKey == "" || len(key) < len(matchedKey) {
			matchedKey = key
			matchedPrice = price
		}
	}
	return matchedPrice, matchedKey != ""
}

func successRate(successCount int64, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return float64(successCount) / float64(total)
}

func sliceBounds(total int, limit int, offset int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	if limit <= 0 {
		limit = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return offset, end
}

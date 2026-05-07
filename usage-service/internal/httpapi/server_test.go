package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager/usage-service/internal/collector"
	"github.com/seakee/cpa-manager/usage-service/internal/config"
	"github.com/seakee/cpa-manager/usage-service/internal/store"
)

type observedRequest struct {
	path  string
	query string
	auth  string
}

func newTestHandler(t *testing.T, upstreamURL string, saveSetup bool) http.Handler {
	t.Helper()

	cfg := config.Config{
		DBPath:      filepath.Join(t.TempDir(), "usage.sqlite"),
		Queue:       "usage",
		PopSide:     "right",
		CORSOrigins: []string{"*"},
	}
	db, err := store.Open(cfg.DBPath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	if saveSetup {
		err := db.SaveSetup(context.Background(), store.Setup{
			CPAUpstreamURL: upstreamURL,
			ManagementKey:  "management-key",
			Queue:          "usage",
			PopSide:        "right",
		})
		if err != nil {
			t.Fatalf("save setup: %v", err)
		}
	}

	manager := collector.NewManager(cfg, db)
	return New(cfg, db, manager).Handler()
}

func TestModelListProxyPreservesAuthorization(t *testing.T) {
	for _, path := range []string{"/v1/models", "/models"} {
		t.Run(path, func(t *testing.T) {
			observed := make(chan observedRequest, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				observed <- observedRequest{
					path:  r.URL.Path,
					query: r.URL.RawQuery,
					auth:  r.Header.Get("Authorization"),
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"}]}`))
			}))
			t.Cleanup(upstream.Close)

			handler := newTestHandler(t, upstream.URL, true)
			req := httptest.NewRequest(http.MethodGet, path+"?limit=20", nil)
			req.Header.Set("Authorization", "Bearer upstream-key")
			rr := httptest.NewRecorder()

			handler.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
			}
			if !strings.Contains(rr.Body.String(), "gpt-4o") {
				t.Fatalf("response body = %s", rr.Body.String())
			}

			var got observedRequest
			select {
			case got = <-observed:
			default:
				t.Fatal("upstream was not called")
			}
			if got.path != path {
				t.Fatalf("proxied path = %q, want %q", got.path, path)
			}
			if got.query != "limit=20" {
				t.Fatalf("proxied query = %q, want limit=20", got.query)
			}
			if got.auth != "Bearer upstream-key" {
				t.Fatalf("proxied authorization = %q", got.auth)
			}
		})
	}
}

func TestModelListProxyRequiresSetup(t *testing.T) {
	handler := newTestHandler(t, "", false)
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "usage service is not configured") {
		t.Fatalf("response body = %s", rr.Body.String())
	}
}

func TestModelPricesSaveAndLoad(t *testing.T) {
	handler := newTestHandler(t, "http://example.test", true)
	body := bytes.NewBufferString(`{"prices":{"gpt-test":{"prompt":1.25,"completion":2.5,"cache":0.1}}}`)
	req := httptest.NewRequest(http.MethodPut, "/v0/management/model-prices", body)
	req.Header.Set("Authorization", "Bearer management-key")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", rr.Code, rr.Body.String())
	}

	req = httptest.NewRequest(http.MethodGet, "/v0/management/model-prices", nil)
	req.Header.Set("Authorization", "Bearer management-key")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("load status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var response struct {
		Prices map[string]struct {
			Prompt     float64 `json:"prompt"`
			Completion float64 `json:"completion"`
			Cache      float64 `json:"cache"`
		} `json:"prices"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	price, ok := response.Prices["gpt-test"]
	if !ok {
		t.Fatalf("missing saved price: %#v", response.Prices)
	}
	if price.Prompt != 1.25 || price.Completion != 2.5 || price.Cache != 0.1 {
		t.Fatalf("price = %#v", price)
	}
}

func TestModelPricesSyncFromLiteLLMFormat(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"sample_spec": {},
			"gpt-test": {
				"input_cost_per_token": 0.00000125,
				"output_cost_per_token": 0.0000025,
				"cache_read_input_token_cost": 0.0000001,
				"mode": "chat"
			},
			"image-only": {
				"output_cost_per_image": 0.04,
				"mode": "image_generation"
			}
		}`))
	}))
	t.Cleanup(source.Close)
	oldURL := modelPriceSyncURL
	modelPriceSyncURL = source.URL
	t.Cleanup(func() {
		modelPriceSyncURL = oldURL
	})

	handler := newTestHandler(t, "http://example.test", true)
	req := httptest.NewRequest(
		http.MethodPost,
		"/v0/management/model-prices/sync",
		bytes.NewBufferString(`{"models":["gpt-test"]}`),
	)
	req.Header.Set("Authorization", "Bearer management-key")
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("sync status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var response struct {
		Source   string `json:"source"`
		Imported int    `json:"imported"`
		Skipped  int    `json:"skipped"`
		Prices   map[string]struct {
			Prompt        float64 `json:"prompt"`
			Completion    float64 `json:"completion"`
			Cache         float64 `json:"cache"`
			Source        string  `json:"source"`
			SourceModelID string  `json:"sourceModelId"`
		} `json:"prices"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Source != "litellm" || response.Imported != 1 || response.Skipped != 2 {
		t.Fatalf("sync summary = %#v", response)
	}
	price, ok := response.Prices["gpt-test"]
	if !ok {
		t.Fatalf("missing synced price: %#v", response.Prices)
	}
	if !closeFloat(price.Prompt, 1.25) || !closeFloat(price.Completion, 2.5) || !closeFloat(price.Cache, 0.1) {
		t.Fatalf("price = %#v", price)
	}
	if price.Source != "litellm" || price.SourceModelID != "gpt-test" {
		t.Fatalf("source metadata = %#v", price)
	}
}

func TestUsageStatsEndpoints(t *testing.T) {
	handler := newTestHandler(t, "http://example.test", true)

	pricesBody := bytes.NewBufferString(`{"prices":{"gpt-test":{"prompt":1.0,"completion":2.0,"cache":0.5}}}`)
	pricesReq := httptest.NewRequest(http.MethodPut, "/v0/management/model-prices", pricesBody)
	pricesReq.Header.Set("Authorization", "Bearer management-key")
	pricesRR := httptest.NewRecorder()
	handler.ServeHTTP(pricesRR, pricesReq)
	if pricesRR.Code != http.StatusOK {
		t.Fatalf("save prices status = %d, body = %s", pricesRR.Code, pricesRR.Body.String())
	}

	importBody := bytes.NewBufferString(strings.Join([]string{
		`{"timestamp":"2026-05-06T10:00:00Z","model":"gpt-test","api_key":"sk-user-1-abcdefghijklmnopqrstuvwxyz","source":"sk-user-1-abcdefghijklmnopqrstuvwxyz","input_tokens":100,"output_tokens":20,"reasoning_tokens":5,"cached_tokens":20,"total_tokens":145}`,
		`{"timestamp":"2026-05-06T11:00:00Z","model":"gpt-test","api_key":"sk-user-1-abcdefghijklmnopqrstuvwxyz","source":"sk-user-1-abcdefghijklmnopqrstuvwxyz","input_tokens":50,"output_tokens":10,"total_tokens":60,"failed":true}`,
		`{"timestamp":"2026-05-06T12:00:00Z","model":"gpt-test","api_key":"sk-user-2-abcdefghijklmnopqrstuvwxyz","source":"sk-user-2-abcdefghijklmnopqrstuvwxyz","input_tokens":30,"output_tokens":15,"cached_tokens":5,"total_tokens":50}`,
	}, "\n"))
	importReq := httptest.NewRequest(http.MethodPost, "/v0/management/usage/import", importBody)
	importReq.Header.Set("Authorization", "Bearer management-key")
	importRR := httptest.NewRecorder()
	handler.ServeHTTP(importRR, importReq)
	if importRR.Code != http.StatusOK {
		t.Fatalf("import status = %d, body = %s", importRR.Code, importRR.Body.String())
	}

	overviewReq := httptest.NewRequest(http.MethodGet, "/v0/management/usage/overview?range=30d", nil)
	overviewReq.Header.Set("Authorization", "Bearer management-key")
	overviewRR := httptest.NewRecorder()
	handler.ServeHTTP(overviewRR, overviewReq)
	if overviewRR.Code != http.StatusOK {
		t.Fatalf("overview status = %d, body = %s", overviewRR.Code, overviewRR.Body.String())
	}
	var overview struct {
		Requests        int64 `json:"requests"`
		SuccessCount    int64 `json:"successCount"`
		FailureCount    int64 `json:"failureCount"`
		InputTokens     int64 `json:"inputTokens"`
		OutputTokens    int64 `json:"outputTokens"`
		ReasoningTokens int64 `json:"reasoningTokens"`
		CachedTokens    int64 `json:"cachedTokens"`
		TotalTokens     int64 `json:"totalTokens"`
		EstimatedCost   float64 `json:"estimatedCost"`
		Series          []struct {
			Requests int64 `json:"requests"`
		} `json:"series"`
	}
	if err := json.Unmarshal(overviewRR.Body.Bytes(), &overview); err != nil {
		t.Fatalf("decode overview: %v", err)
	}
	if overview.Requests != 3 || overview.SuccessCount != 2 || overview.FailureCount != 1 {
		t.Fatalf("unexpected overview counters: %#v", overview)
	}
	if overview.InputTokens != 180 || overview.OutputTokens != 45 || overview.ReasoningTokens != 5 || overview.CachedTokens != 25 || overview.TotalTokens != 255 {
		t.Fatalf("unexpected overview tokens: %#v", overview)
	}
	if overview.EstimatedCost <= 0 || len(overview.Series) == 0 {
		t.Fatalf("unexpected overview cost/series: %#v", overview)
	}

	identitiesReq := httptest.NewRequest(http.MethodGet, "/v0/management/usage/identities?range=30d&limit=10", nil)
	identitiesReq.Header.Set("Authorization", "Bearer management-key")
	identitiesRR := httptest.NewRecorder()
	handler.ServeHTTP(identitiesRR, identitiesReq)
	if identitiesRR.Code != http.StatusOK {
		t.Fatalf("identities status = %d, body = %s", identitiesRR.Code, identitiesRR.Body.String())
	}
	var identities struct {
		Total int `json:"total"`
		Items []struct {
			IdentityHash  string  `json:"identityHash"`
			DisplaySource string  `json:"displaySource"`
			Requests      int64   `json:"requests"`
			SuccessCount  int64   `json:"successCount"`
			FailureCount  int64   `json:"failureCount"`
			EstimatedCost float64 `json:"estimatedCost"`
		} `json:"items"`
	}
	if err := json.Unmarshal(identitiesRR.Body.Bytes(), &identities); err != nil {
		t.Fatalf("decode identities: %v", err)
	}
	if identities.Total != 2 || len(identities.Items) != 2 {
		t.Fatalf("unexpected identities payload: %#v", identities)
	}
	if identities.Items[0].IdentityHash == "" || identities.Items[0].DisplaySource == "" {
		t.Fatalf("first identity missing fields: %#v", identities.Items[0])
	}
	if identities.Items[0].Requests != 2 || identities.Items[0].SuccessCount != 1 || identities.Items[0].FailureCount != 1 {
		t.Fatalf("unexpected first identity stats: %#v", identities.Items[0])
	}
	if identities.Items[0].EstimatedCost <= 0 {
		t.Fatalf("expected identity cost > 0: %#v", identities.Items[0])
	}

	eventsReq := httptest.NewRequest(http.MethodGet, "/v0/management/usage/events?range=30d&result=failed&page_size=10", nil)
	eventsReq.Header.Set("Authorization", "Bearer management-key")
	eventsRR := httptest.NewRecorder()
	handler.ServeHTTP(eventsRR, eventsReq)
	if eventsRR.Code != http.StatusOK {
		t.Fatalf("events status = %d, body = %s", eventsRR.Code, eventsRR.Body.String())
	}
	var events struct {
		Total int64 `json:"total"`
		Items []struct {
			Result string `json:"result"`
			Failed bool   `json:"failed"`
		} `json:"items"`
	}
	if err := json.Unmarshal(eventsRR.Body.Bytes(), &events); err != nil {
		t.Fatalf("decode events: %v", err)
	}
	if events.Total != 1 || len(events.Items) != 1 || !events.Items[0].Failed || events.Items[0].Result != "failed" {
		t.Fatalf("unexpected events payload: %#v", events)
	}
}

func closeFloat(left float64, right float64) bool {
	return math.Abs(left-right) < 0.0000001
}

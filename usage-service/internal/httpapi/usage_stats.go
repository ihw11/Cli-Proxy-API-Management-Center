package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager/usage-service/internal/store"
)

func (s *Server) handleUsageOverview(w http.ResponseWriter, r *http.Request) {
	window, err := parseUsageWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	payload, err := s.store.UsageOverview(r.Context(), window)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleUsageIdentities(w http.ResponseWriter, r *http.Request) {
	window, err := parseUsageWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	limit := parsePositiveInt(r.URL.Query().Get("limit"), 50, 500)
	offset := parseNonNegativeInt(r.URL.Query().Get("offset"), 0)
	search := strings.TrimSpace(r.URL.Query().Get("q"))
	payload, err := s.store.UsageIdentities(r.Context(), window, search, limit, offset)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleUsageEvents(w http.ResponseWriter, r *http.Request) {
	window, err := parseUsageWindow(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pageSize := parsePositiveInt(firstQueryValue(r, "page_size", "pageSize", "limit"), 20, 200)
	page := parsePositiveInt(r.URL.Query().Get("page"), 1, 10_000)
	offset := parseNonNegativeInt(r.URL.Query().Get("offset"), (page-1)*pageSize)
	payload, err := s.store.UsageEvents(r.Context(), store.UsageEventsQuery{
		Window: window,
		Source: strings.TrimSpace(r.URL.Query().Get("source")),
		Model:  strings.TrimSpace(r.URL.Query().Get("model")),
		Result: strings.TrimSpace(r.URL.Query().Get("result")),
		Limit:  pageSize,
		Offset: offset,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func parseUsageWindow(r *http.Request) (store.UsageWindow, error) {
	now := time.Now().UTC()
	rangeValue := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("range")))
	startValue := strings.TrimSpace(firstQueryValue(r, "start", "from"))
	endValue := strings.TrimSpace(firstQueryValue(r, "end", "to"))

	if startValue != "" || endValue != "" {
		fromMS, err := parseTimestampValue(startValue)
		if err != nil {
			return store.UsageWindow{}, err
		}
		toMS, err := parseTimestampValue(endValue)
		if err != nil {
			return store.UsageWindow{}, err
		}
		if fromMS <= 0 || toMS <= 0 {
			return store.UsageWindow{}, errors.New("start and end are required")
		}
		if fromMS > toMS {
			return store.UsageWindow{}, errors.New("start must be before end")
		}
		return store.UsageWindow{FromMS: fromMS, ToMS: toMS}, nil
	}

	switch rangeValue {
	case "", "24h":
		return store.UsageWindow{FromMS: now.Add(-24 * time.Hour).UnixMilli(), ToMS: now.UnixMilli()}, nil
	case "7d":
		return store.UsageWindow{FromMS: now.Add(-7 * 24 * time.Hour).UnixMilli(), ToMS: now.UnixMilli()}, nil
	case "30d":
		return store.UsageWindow{FromMS: now.Add(-30 * 24 * time.Hour).UnixMilli(), ToMS: now.UnixMilli()}, nil
	case "today":
		startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
		return store.UsageWindow{FromMS: startOfDay.UnixMilli(), ToMS: now.UnixMilli()}, nil
	case "all":
		return store.UsageWindow{FromMS: 0, ToMS: now.UnixMilli()}, nil
	case "custom":
		return store.UsageWindow{}, errors.New("custom range requires start and end")
	default:
		return store.UsageWindow{}, errors.New("unsupported range")
	}
}

func parseTimestampValue(raw string) (int64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0, nil
	}
	if number, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		if number > 0 && number < 10_000_000_000 {
			return number * 1000, nil
		}
		return number, nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed.UTC().UnixMilli(), nil
		}
	}
	return 0, errors.New("invalid timestamp value")
}

func parsePositiveInt(raw string, fallback int, max int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value <= 0 {
		value = fallback
	}
	if max > 0 && value > max {
		return max
	}
	return value
}

func parseNonNegativeInt(raw string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 0 {
		return fallback
	}
	return value
}

func firstQueryValue(r *http.Request, keys ...string) string {
	query := r.URL.Query()
	for _, key := range keys {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			return value
		}
	}
	return ""
}

-- Faz 6 (K.3) yükseltme yolu fikstürü: 0000 (Faz 1) şemasında geçerli, temsilî satırlar. Yalnızca SENTETİK veri
-- (gerçek firma/kişi yok; alan adları .example). tests/migration-upgrade-path.test.ts fikstürleri 0000'dan başlayarak
-- SIRAYLA yükler (k. şemada 0000..k), sonra güncel sürüme yükseltir ve her satırın korunduğunu denetler.
INSERT INTO settings (key, value, updated_at) VALUES
  ('setup.completed', 'true', 1795000000000),
  ('budget.monthlyUsd', '25', 1795000000000),
  ('places.provider', '"mock"', 1795000000000),
  ('targets.countries', '["GB","NL"]', 1795000000000);
INSERT INTO regions (id, name, kind, country_code, geometry, grid_size_m, schedule_days, last_scan_at, created_at) VALUES
  (1, 'Londra merkez', 'city', 'GB', '{"south":51.48,"west":-0.17,"north":51.54,"east":-0.07}', NULL, NULL, 1795000100000, 1795000000000);
INSERT INTO category_sets (id, key, name, place_types, keywords, enabled, built_in, priority, sort_order) VALUES
  (1, 'fixture_cafe', 'Kafe (fikstür)', '["cafe"]', '["kafe"]', 1, 0, 1, 90);
INSERT INTO scans (id, region_id, scan_key, category_set_ids, queries, strategy, field_profile, provider, status, calls_by_sku, cost_usd, progress, is_baseline, created_at, started_at, finished_at) VALUES
  (1, 1, 'fixture-london', '[1]', '[]', 'text', 'discovery', 'mock', 'completed', '{"text":2}', 0, '{"done":1}', 1, 1795000000000, 1795000010000, 1795000100000);
INSERT INTO scan_units (id, scan_id, parent_id, depth, south, west, north, east, kind, term_kind, term, status, calls_made, result_count, saturated, updated_at) VALUES
  (1, 1, NULL, 0, 51.48, -0.17, 51.54, -0.07, 'text', 'type', 'cafe', 'done', 2, 3, 0, 1795000100000);
INSERT INTO places (place_id, source, lat, lng, coords_fetched_at, was_future, is_closed, first_seen_scan_id, last_seen_scan_id, first_seen_at, created_at, updated_at) VALUES
  ('fx-place-1', 'mock', 51.51, -0.12, 1795000050000, 0, 0, 1, 1, 1795000050000, 1795000050000, 1795000050000),
  ('fx-place-2', 'mock', 51.52, -0.11, 1795000050000, 1, 0, 1, 1, 1795000050000, 1795000050000, 1795000050000),
  ('fx-place-3', 'mock', 51.50, -0.10, 1795000050000, 0, 1, 1, 1, 1795000050000, 1795000050000, 1795000050000);
INSERT INTO place_snapshots (scan_id, place_id, was_future) VALUES
  (1, 'fx-place-1', 0), (1, 'fx-place-2', 1), (1, 'fx-place-3', 0);
INSERT INTO leads (id, place_id, source, display_name, country_code, city, category_key, novelty_score, novelty_label, novelty_signals, status, language, notes, tags, created_at, updated_at) VALUES
  (1, 'fx-place-1', 'scan', 'Kafe 0001', 'GB', 'London', 'cafe', 72, 'high', '["new_place"]', 'new', 'en', 'Not: kapı sağda', '["vip"]', 1795000060000, 1795000060000),
  (2, 'fx-place-2', 'scan', 'Kafe 0002', 'GB', 'London', 'cafe', 90, 'future_opening', '["future"]', 'enriched', 'en', NULL, '[]', 1795000060000, 1795000060000),
  (3, 'fx-place-3', 'scan', 'Kafe 0003', 'GB', 'London', 'cafe', 10, 'low', '[]', 'new', NULL, NULL, '[]', 1795000060000, 1795000060000);
INSERT INTO jobs (id, type, payload, status, priority, attempts, max_attempts, run_at, dedupe_key, created_at, updated_at, finished_at) VALUES
  (1, 'scan.run', '{"scanId":1}', 'done', 0, 1, 3, 1795000000000, 'scan:1', 1795000000000, 1795000100000, 1795000100000);
INSERT INTO api_usage (id, provider, sku, day, calls, est_cost_usd) VALUES
  (1, 'mock', 'text_search_pro', '2026-11-01', 2, 0);
INSERT INTO audit_log (id, at, action, entity, entity_id, detail) VALUES
  (1, 1795000000000, 'scan.start', 'scan', '1', '{"provider":"mock"}');

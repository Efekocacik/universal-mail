-- Faz 6 (K.3) yükseltme yolu fikstürü: 0004 (Faz 4: bildirimler, zamanlamalar, kayıtlı süzgeçler, alan adı kaydı,
-- arşiv). Sentetik veri.
INSERT INTO scan_schedules (id, region_id, scan_key, category_set_ids, custom_keywords, strategy, field_profile, interval_days, enabled, max_cost_usd, next_run_at, last_run_at, last_scan_id, last_outcome, missed_runs, created_at, updated_at) VALUES
  (1, 1, 'fixture-weekly', '[1]', '["kafe"]', 'text', 'discovery', 7, 1, 2.5, 1795600000000, 1795000600000, 1, 'completed', 0, 1795000000000, 1795000600000);
INSERT INTO scans (id, region_id, scan_key, category_set_ids, queries, strategy, field_profile, provider, status, created_at, finished_at, origin, schedule_id, schedule_slot) VALUES
  (2, 1, 'fixture-weekly', '[1]', '[]', 'text', 'discovery', 'mock', 'completed', 1795000600000, 1795000700000, 'schedule', 1, 1);
INSERT INTO notifications (id, kind, dedupe_key, params, url, entity, entity_id, created_at, read_at) VALUES
  (1, 'scan.done', 'scan.done:2', '{"n":3}', '/scans', 'scan', '2', 1795000700000, NULL);
INSERT INTO saved_filters (id, name, name_key, payload, sort, include_area, created_at, updated_at) VALUES
  (1, 'Londra kafeleri', 'londra kafeleri', '{"q":"kafe","countries":["GB"]}', 'novelty', 0, 1795000600000, 1795000600000);
INSERT INTO domain_registrations (domain, status, registered_at, rdap_host, attempts, checked_at, next_check_at, created_at, updated_at) VALUES
  ('kafe-0001.example', 'ok', 1794000000000, 'rdap.example', 1, 1795000600000, 1797000000000, 1795000600000, 1795000600000);
UPDATE leads SET archived_at = 1795000650000 WHERE id = 3;
UPDATE places SET gone_at = 1795000650000, status_checked_at = 1795000650000 WHERE place_id = 'fx-place-3';
UPDATE lead_enrichment SET site_domain = 'kafe-0001.example' WHERE lead_id = 1;

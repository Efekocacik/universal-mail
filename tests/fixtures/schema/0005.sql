-- Faz 6 (K.3) yükseltme yolu fikstürü: 0005 (Faz 5: sicil, içe aktarma, AI tanıtım, açılma izleme, A/B konu).
-- Sentetik veri (sicil numarası ve adlar uydurmadır).
INSERT INTO registry_runs (id, source, is_demo, status, activity_scheme, activity_codes, window_from, window_to, fetched_count, new_count, matched_count, created_at, started_at, finished_at) VALUES
  (1, 'companies_house', 1, 'done', 'SIC2007', '["56102"]', '2026-10-01', '2026-10-31', 1, 1, 1, 1795000800000, 1795000800000, 1795000900000);
INSERT INTO registry_companies (id, source, is_demo, external_id, name, name_norm, country_code, activity_scheme, activity_codes, category_key, incorporated_on, postcode, locality, registry_status, last_run_id, match_status, match_reason, match_score, matched_place_id, matched_at, lead_id, first_seen_at, last_seen_at, updated_at) VALUES
  (1, 'companies_house', 1, 'FX000001', 'KAFE 0001 LTD', 'kafe 0001', 'GB', 'SIC2007', '["56102"]', 'cafe', '2026-10-10', 'EC1A 1AA', 'London', 'active', 1, 'matched', 'name_postcode', 0.92, 'fx-place-1', 1795000900000, 1, 1795000900000, 1795000900000, 1795000900000);
INSERT INTO import_batches (id, filename, format, source_note, usage_ack_at, mapping, row_count, created_count, duplicate_count, invalid_count, created_at) VALUES
  (1, 'fuar-listesi.csv', 'csv', 'Fuar katılımcı listesi', 1795001000000, '{"name":"Firma"}', 3, 1, 1, 1, 1795001000000);
INSERT INTO leads (id, source, display_name, country_code, city, status, created_at, updated_at, website) VALUES
  (4, 'import', 'Kafe 0004', 'NL', 'Amsterdam', 'new', 1795001000000, 1795001000000, 'https://kafe-0004.example');
INSERT INTO import_batch_leads (batch_id, lead_id, row_number) VALUES (1, 4, 2);
INSERT INTO lead_intros (id, lead_id, language, text, status, model, source_domain, input_tokens, output_tokens, est_cost_usd, created_at, updated_at, approved_at) VALUES
  (1, 1, 'en', 'Saw your new cafe near the station.', 'approved', 'claude-fixture-1', 'kafe-0001.example', 120, 30, 0.001, 1795001100000, 1795001100000, 1795001100000);
INSERT INTO campaign_step_templates (campaign_id, step_index, language, category_key, template_id) VALUES
  (1, 0, 'en', 'cafe', 1);
INSERT INTO message_opens (message_id, campaign_id, first_opened_at, last_opened_at, open_count, source) VALUES
  (1, 1, 1795000350000, 1795000450000, 2, 'demo_simulated');
UPDATE templates SET subject_b = 'Hi {{business}}' WHERE id = 1;
UPDATE messages SET subject_variant = 'a' WHERE id = 1;

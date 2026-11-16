-- Faz 6 (K.3) yükseltme yolu fikstürü: 0001 (Faz 2 e-posta) tabloları. Sentetik veri.
INSERT INTO lead_emails (id, lead_id, email, domain, kind, source_url, source_type, site_match, verify_status, verify_reason, verified_at, is_primary, primary_pinned, found_at, updated_at) VALUES
  (1, 1, 'info@kafe-0001.example', 'kafe-0001.example', 'generic', 'https://kafe-0001.example/iletisim', 'website', 1, 'valid', NULL, 1795000070000, 1, 0, 1795000070000, 1795000070000),
  (2, 1, 'ayse@kafe-0001.example', 'kafe-0001.example', 'personal', 'https://kafe-0001.example/ekip', 'website', 1, 'unverified', NULL, NULL, 0, 0, 1795000070000, 1795000070000),
  (3, 2, 'hello@kafe-0002.example', 'kafe-0002.example', 'generic', NULL, 'external', 1, 'risky', 'catch_all', 1795000070000, 1, 1, 1795000070000, 1795000070000);
INSERT INTO lead_contacts (id, lead_id, type, url, found_at) VALUES
  (1, 1, 'instagram', 'https://social.example/kafe0001', 1795000070000);
INSERT INTO lead_enrichment (lead_id, status, email_status, attempts, last_attempt_at, pages_fetched, external_used, completed_at, updated_at) VALUES
  (1, 'done', 'found', 1, 1795000070000, 3, 0, 1795000070000, 1795000070000),
  (2, 'done', 'found', 2, 1795000070000, 1, 1, 1795000070000, 1795000070000);

-- Faz 6 (K.3) yükseltme yolu fikstürü: 0002 (Faz 3 kampanya/gönderim) tabloları. Sentetik veri.
INSERT INTO mailboxes (id, provider, label, address, credentials_ref, status, daily_cap, warmup_step, connected_at, created_at, updated_at) VALUES
  (1, 'demo', 'Demo kutusu', 'demo@firma.example', NULL, 'connected', 20, 10, 1795000000000, 1795000000000, 1795000000000);
INSERT INTO templates (id, name, language, category_key, kind, subject, body_html, body_text, built_in, version, created_at, updated_at) VALUES
  (1, 'Tanıtım (fikstür)', 'en', 'cafe', 'initial', 'Hello {{business}}', '<p>Hello</p>', 'Hello', 0, 2, 1795000000000, 1795000000000),
  (2, 'Hatırlatma (fikstür)', 'en', 'cafe', 'followup', 'Re: Hello', '<p>Again</p>', 'Again', 0, 1, 1795000000000, 1795000000000);
INSERT INTO campaigns (id, name, status, mailbox_id, selection, send_window, daily_cap, min_gap_s, max_gap_s, start_confirmed_at, started_at, created_at, updated_at) VALUES
  (1, 'Londra kafeler', 'running', 1, '{"leadIds":[1,2]}', '{"start":"09:00","end":"17:00"}', 20, 90, 240, 1795000200000, 1795000200000, 1795000150000, 1795000200000);
INSERT INTO campaign_steps (campaign_id, step_index, language, template_id, delay_days) VALUES
  (1, 0, 'en', 1, 0), (1, 1, 'en', 2, 5);
INSERT INTO campaign_leads (id, campaign_id, lead_id, email_id, recipient_email, recipient_hash, recipient_domain, country_code, language, status, exclusion_reasons, next_step, next_send_at, last_sent_at, attempts, added_at, updated_at) VALUES
  (1, 1, 1, 1, 'info@kafe-0001.example', 'hash-0001', 'kafe-0001.example', 'GB', 'en', 'waiting_next', '[]', 1, 1795500000000, 1795000300000, 1, 1795000150000, 1795000300000);
INSERT INTO messages (id, direction, purpose, campaign_id, campaign_lead_id, lead_id, mailbox_id, template_id, template_version, step_index, idempotency_key, rfc_message_id, from_address, to_address, peer_hash, peer_domain, send_day, subject_logged, status, created_at, sent_at) VALUES
  (1, 'out', 'campaign', 1, 1, 1, 1, 1, 2, 0, 'c1:l1:s0', '<fx-1@firma.example>', 'demo@firma.example', 'info@kafe-0001.example', 'hash-0001', 'kafe-0001.example', '2026-11-01', 'Hello Kafe 0001', 'sent', 1795000300000, 1795000300000),
  (2, 'out', 'test', NULL, NULL, NULL, 1, 1, 2, NULL, NULL, '<fx-2@firma.example>', 'demo@firma.example', 'demo@firma.example', 'hash-self', 'firma.example', NULL, '[TEST] Hello', 'sent', 1795000250000, 1795000250000);
INSERT INTO messages (id, direction, purpose, lead_id, mailbox_id, rfc_message_id, in_reply_to, peer_hash, peer_domain, status, classification, created_at, received_at) VALUES
  (3, 'in', 'inbound', 1, 1, '<fx-3@kafe-0001.example>', '<fx-1@firma.example>', 'hash-0001', 'kafe-0001.example', 'matched', 'reply', 1795000400000, 1795000400000);
INSERT INTO suppressions (id, scope, email_hash, hash_alg, email_masked, domain, reason, source, message_id, note, added_at) VALUES
  (1, 'domain', NULL, NULL, NULL, 'spam.example', 'manual', 'manual', NULL, 'elle eklendi', 1795000000000),
  (2, 'email', 'hash-0003', 'sha256', 'h***@kafe-0002.example', 'kafe-0002.example', 'unsubscribe', 'inbox', 3, NULL, 1795000400000);
INSERT INTO country_policies (scope, country_code, mode, locked, seed_version, updated_at) VALUES
  ('demo', 'ZZ', 'allowed', 0, 1, 1795000000000);
UPDATE leads SET last_contacted_at = 1795000300000, status = 'sent' WHERE id = 1;

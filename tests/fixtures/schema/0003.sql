-- Faz 6 (K.3) yükseltme yolu fikstürü: 0003 (ARF şikâyet: campaign_leads.stop_reason, messages.classification
-- 'complaint'). Sentetik veri.
INSERT INTO campaign_leads (id, campaign_id, lead_id, email_id, recipient_email, recipient_hash, recipient_domain, country_code, language, status, exclusion_reasons, next_step, attempts, added_at, updated_at, stop_reason) VALUES
  (2, 1, 2, 3, 'hello@kafe-0002.example', 'hash-0002', 'kafe-0002.example', 'GB', 'en', 'unsubscribed', '["arf_complaint"]', 1, 1, 1795000150000, 1795000500000, 'complaint');
INSERT INTO messages (id, direction, purpose, lead_id, mailbox_id, rfc_message_id, peer_hash, peer_domain, status, classification, error_code, created_at, received_at) VALUES
  (4, 'in', 'inbound', 2, 1, '<fx-4@feedback.example>', 'hash-0002', 'kafe-0002.example', 'matched', 'complaint', 'arf_complaint', 1795000500000, 1795000500000);

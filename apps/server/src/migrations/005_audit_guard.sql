-- WP 3.8, NFR-11: the audit log is append-only in the database itself, not only in the
-- application. No row can be changed, and none can be removed before it is a year old.
-- (The function body stays on one line: migrations are split at a semicolon that ends a line.)
CREATE FUNCTION audit_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'The audit log is append-only: entries cannot be changed.'; END IF; IF TG_OP = 'TRUNCATE' THEN RAISE EXCEPTION 'Audit entries are kept for at least a year (NFR-11).'; END IF; IF OLD.at > now() - interval '366 days' THEN RAISE EXCEPTION 'Audit entries are kept for at least a year (NFR-11).'; END IF; RETURN OLD; END $$;

CREATE TRIGGER audit_events_rows BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_guard();

CREATE TRIGGER audit_events_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_guard();

-- How far the syslog forwarder has sent (seq of the last entry delivered).
INSERT INTO settings (key, value) VALUES ('audit.forwardedSeq', '0') ON CONFLICT (key) DO NOTHING;

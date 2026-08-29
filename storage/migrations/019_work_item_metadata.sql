-- createWorkItemSchema had no metadata field, so the webhook ingest handler
-- (POST /webhooks/:source) building { metadata: { webhookSource, correlationId } }
-- had that object silently stripped by Zod before it ever reached create() -
-- an accepted webhook's caller-supplied correlationId was never persisted
-- anywhere the work item's own record could be traced back to it. This adds
-- a place to actually store it.
ALTER TABLE work_items ADD COLUMN metadata_json TEXT;

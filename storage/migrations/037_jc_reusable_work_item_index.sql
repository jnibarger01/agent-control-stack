-- Jace Commander capability issuance frequently needs to find the newest
-- reusable approval work item for one requester. Keep that lookup bounded by
-- requester + status instead of scanning and decoding the full work-item
-- history.
CREATE INDEX IF NOT EXISTS idx_work_items_requester_status_created
ON work_items(requester_subject, status, created_at DESC);

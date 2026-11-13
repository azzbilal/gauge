-- One row per peer review of a task. Legacy rows (written before the two-reviewer
-- protocol) have no reviewer_expert_id; they are kept but flagged.
select
    id                              as review_id,
    "taskId"                        as task_id,
    "reviewerExpertId"              as reviewer_expert_id,
    "reviewerId"                    as reviewer_label,
    "reviewerExpertId" is null      as is_legacy,
    accepted,
    "createdAt"                     as created_at
from {{ source('raw', 'task_review') }}

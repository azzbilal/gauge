-- One row per peer review of a task. Legacy rows (written before the two-reviewer
-- protocol) have no reviewer_expert_id; they are kept but flagged.
select
    id                              as review_id,
    "taskId"                        as task_id,
    "reviewerExpertId"              as reviewer_expert_id,
    "reviewerId"                    as reviewer_label,
    "reviewerExpertId" is null      as is_legacy,
    accepted,
    -- JSON text keyed by criterion: scores -> 0..5, evidence -> the reviewer's note
    -- (evidence is null on rows written before evidence was collected).
    cast(scores as varchar)         as scores_json,
    cast(evidence as varchar)       as evidence_json,
    "createdAt"                     as created_at
from {{ source('raw', 'task_review') }}

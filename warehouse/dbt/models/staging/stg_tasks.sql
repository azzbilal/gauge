-- One row per task, every task kept (gold tasks and gold clones included and flagged),
-- so reviews of any task resolve here.
select
    id                              as task_id,
    "campaignId"                    as campaign_id,
    "authorId"                      as author_id,
    cast(status as varchar)         as status,
    "isGold"                        as is_gold,
    "goldSourceId" is not null      as is_gold_clone,
    "goldExpectedAccept"            as gold_expected_accept,
    "createdAt"                     as created_at,
    "updatedAt"                     as updated_at
from {{ source('raw', 'task') }}

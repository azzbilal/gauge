-- Per-campaign throughput, acceptance and reviewer agreement.
-- Gold tasks (calibration items, incl. clones) are excluded from every metric and
-- counted separately in gold_task_count. Definitions are in models/marts/marts.yml.
with tasks as (
    select * from {{ ref('stg_tasks') }}
),

-- Reviews aggregated to one row per task before joining, so task counts don't fan out.
-- Only identified reviews (non-legacy) count toward agreement.
review_per_task as (
    select
        task_id,
        count(*)                                  as n_reviews,
        count(*) filter (where accepted)          as n_accept,
        count(*) filter (where not accepted)      as n_reject
    from {{ ref('stg_reviews') }}
    where not is_legacy
    group by task_id
),

task_metrics as (
    select
        t.campaign_id,
        count(*) filter (where not t.is_gold)                                        as task_count,
        count(*) filter (where t.is_gold)                                            as gold_task_count,
        count(*) filter (where not t.is_gold and t.status = 'ACCEPTED')              as accepted_count,
        count(*) filter (where not t.is_gold and t.status = 'REJECTED')              as rejected_count,
        count(*) filter (where not t.is_gold and coalesce(r.n_reviews, 0) >= 2)      as multi_reviewed_count,
        count(*) filter (
            where not t.is_gold and r.n_reviews >= 2 and (r.n_accept = 0 or r.n_reject = 0)
        )                                                                            as agreed_count,
        min(t.created_at) filter (where not t.is_gold)                               as first_task_at,
        max(t.created_at) filter (where not t.is_gold)                               as last_task_at
    from tasks t
    left join review_per_task r on r.task_id = t.task_id
    group by t.campaign_id
)

select
    c.id                                        as campaign_id,
    c.name                                      as campaign_name,
    c."targetCount"                             as target_count,
    coalesce(m.task_count, 0)                   as task_count,
    coalesce(m.gold_task_count, 0)              as gold_task_count,
    coalesce(m.accepted_count, 0)               as accepted_count,
    coalesce(m.rejected_count, 0)               as rejected_count,
    round(m.accepted_count / nullif(m.accepted_count + m.rejected_count, 0), 3)  as accept_rate,
    date_diff('day', cast(m.first_task_at as date), cast(m.last_task_at as date)) + 1 as active_days,
    round(
        m.task_count / nullif(
            date_diff('day', cast(m.first_task_at as date), cast(m.last_task_at as date)) + 1, 0
        ), 2
    )                                           as tasks_per_day,
    coalesce(m.multi_reviewed_count, 0)         as multi_reviewed_count,
    coalesce(m.agreed_count, 0)                 as agreed_count,
    round(m.agreed_count / nullif(m.multi_reviewed_count, 0), 3) as reviewer_agreement
from {{ source('raw', 'campaign') }} c
left join task_metrics m on m.campaign_id = c.id

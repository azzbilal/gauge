-- Per reviewer: how their verdicts on gold tasks compare with the gold's known answer.
-- One row per identified reviewer (any expert with at least one non-legacy review), including
-- reviewers with no gold reviews, whose rates are null rather than 0.
-- Gold rates are measured against gold answers only, never against final task status: a
-- reviewer's own vote helps decide that status. Definitions are in models/marts/marts.yml.
with reviews as (
    select * from {{ ref('stg_reviews') }}
    where not is_legacy
),

tasks as (
    select * from {{ ref('stg_tasks') }}
),

-- The known answer for each gold task. A gold clone has no answer of its own; it scores
-- against the gold it copies (docs/pipeline.md §3).
gold_answer as (
    select
        t.task_id,
        coalesce(t.gold_expected_accept, src.gold_expected_accept) as expected_accept
    from tasks t
    left join tasks src on src.task_id = t.gold_source_id
    where t.is_gold
),

per_reviewer as (
    select
        r.reviewer_expert_id,
        count(*)                                                                    as n_reviews,
        count(*) filter (where g.task_id is null)                                   as n_task_reviews,
        count(*) filter (where g.task_id is not null and g.expected_accept is null) as n_gold_unscorable,
        count(g.expected_accept)                                                    as n_gold_reviews,
        count(*) filter (where r.accepted = g.expected_accept)                      as n_gold_correct,
        count(*) filter (where g.expected_accept = false)                           as n_gold_bad,
        count(*) filter (where g.expected_accept = false and r.accepted)            as n_false_accepts,
        count(*) filter (where g.expected_accept = true)                            as n_gold_good,
        count(*) filter (where g.expected_accept = true and not r.accepted)         as n_false_rejects
    from reviews r
    left join gold_answer g on g.task_id = r.task_id
    group by r.reviewer_expert_id
)

select
    p.reviewer_expert_id,
    e.name                                                         as reviewer_name,
    p.n_reviews,
    p.n_task_reviews,
    p.n_gold_reviews,
    p.n_gold_unscorable,
    p.n_gold_correct,
    p.n_gold_bad,
    p.n_false_accepts,
    p.n_gold_good,
    p.n_false_rejects,
    round(p.n_gold_correct / nullif(p.n_gold_reviews, 0), 3)       as gold_accuracy,
    round(p.n_false_accepts / nullif(p.n_gold_bad, 0), 3)          as false_accept_rate,
    round(p.n_false_rejects / nullif(p.n_gold_good, 0), 3)         as false_reject_rate,
    -- GOLD_MIN_REVIEWS = 5 and GOLD_ACCURACY_MIN = 0.8 in review-protocol.ts.
    p.n_gold_reviews >= 5
        and p.n_gold_correct / p.n_gold_reviews < 0.8              as flagged_for_recalibration
from per_reviewer p
left join {{ source('raw', 'expert') }} e on e.id = p.reviewer_expert_id

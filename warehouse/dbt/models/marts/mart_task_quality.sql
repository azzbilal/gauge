-- Per rubric criterion: how decided tasks scored, and how often the score came with evidence.
-- One row per criterion (all five always present, even when nothing is scored yet).
-- Population: every peer review (legacy rows included) of a non-gold task whose status is
-- ACCEPTED or REJECTED. Definitions are in models/marts/marts.yml.
with criteria as (
    -- Must match CRITERIA in apps/api/src/campaign/review-protocol.ts (docs/pipeline.md §2).
    select * from (values
        ('verifiable',           1, 4),
        ('unambiguous',          2, 3),
        ('correct_reference',    3, 3),
        ('complete_constraints', 4, 3),
        ('difficulty',           5, 3)
    ) as c(criterion, criterion_order, acceptance_min)
),

decided_tasks as (
    select task_id, status
    from {{ ref('stg_tasks') }}
    where not is_gold and status in ('ACCEPTED', 'REJECTED')
),

reviews as (
    select r.review_id, r.task_id, r.is_legacy, r.scores_json, r.evidence_json, d.status
    from {{ ref('stg_reviews') }} r
    join decided_tasks d on d.task_id = r.task_id
),

-- One row per (criterion, review). The score is null when the review did not score the
-- criterion; the note is null when missing or blank.
scored as (
    select
        c.criterion,
        r.review_id,
        r.task_id,
        r.status,
        r.is_legacy,
        try_cast(json_extract_string(r.scores_json, '$.' || c.criterion) as double)    as score,
        nullif(trim(json_extract_string(r.evidence_json, '$.' || c.criterion)), '')     as evidence_note
    from criteria c
    cross join reviews r
),

agg as (
    select
        criterion,
        count(distinct task_id) filter (where score is not null)                       as n_tasks,
        count(score)                                                                   as n_scores,
        count(score) filter (where is_legacy)                                          as n_legacy_scores,
        count(score) filter (where evidence_note is not null)                          as n_with_evidence,
        avg(score)                                                                     as avg_score,
        avg(score) filter (where status = 'ACCEPTED')                                  as avg_score_accepted,
        avg(score) filter (where status = 'REJECTED')                                  as avg_score_rejected
    from scored
    group by criterion
)

select
    c.criterion,
    c.criterion_order,
    c.acceptance_min,
    coalesce(a.n_tasks, 0)                                         as n_tasks,
    coalesce(a.n_scores, 0)                                        as n_scores,
    coalesce(a.n_legacy_scores, 0)                                 as n_legacy_scores,
    coalesce(a.n_with_evidence, 0)                                 as n_with_evidence,
    round(a.avg_score, 2)                                          as avg_score,
    round(a.avg_score_accepted, 2)                                 as avg_score_accepted,
    round(a.avg_score_rejected, 2)                                 as avg_score_rejected,
    round(a.n_with_evidence / nullif(a.n_scores, 0), 3)            as share_with_evidence
from criteria c
left join agg a on a.criterion = c.criterion

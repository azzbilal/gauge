-- Every identified reviewer appears exactly once, so no reviewer silently drops out.
with expected as (
    select count(distinct reviewer_expert_id) as n
    from {{ ref('stg_reviews') }}
    where not is_legacy
)
select e.n as expected_reviewers, (select count(*) from {{ ref('mart_reviewer_calibration') }}) as mart_rows
from expected e
where e.n <> (select count(*) from {{ ref('mart_reviewer_calibration') }})

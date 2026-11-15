-- reviewer_exact_agreement is a proportion, so it must lie in [0, 1] whenever it is not null.
select campaign_id, reviewer_exact_agreement
from {{ ref('mart_campaign') }}
where reviewer_exact_agreement is not null
  and (reviewer_exact_agreement < 0 or reviewer_exact_agreement > 1)

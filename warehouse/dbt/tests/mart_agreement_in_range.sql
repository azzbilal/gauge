-- reviewer_agreement is a proportion, so it must lie in [0, 1] whenever it is not null.
select campaign_id, reviewer_agreement
from {{ ref('mart_campaign') }}
where reviewer_agreement is not null and (reviewer_agreement < 0 or reviewer_agreement > 1)

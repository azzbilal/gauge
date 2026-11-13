-- accept_rate is a proportion, so it must lie in [0, 1] whenever it is not null.
select campaign_id, accept_rate
from {{ ref('mart_campaign') }}
where accept_rate is not null and (accept_rate < 0 or accept_rate > 1)

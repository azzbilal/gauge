-- A campaign cannot have more agreeing tasks than it has multi-reviewed tasks.
select campaign_id, agreed_count, multi_reviewed_count
from {{ ref('mart_campaign') }}
where agreed_count > multi_reviewed_count

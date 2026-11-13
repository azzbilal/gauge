-- Every campaign's non-gold task count plus its gold task count must equal its total task rows,
-- so a gold task can never silently drop out of or leak into a metric.
with totals as (
    select campaign_id, count(*) as total_tasks
    from {{ ref('stg_tasks') }}
    group by campaign_id
)
select m.campaign_id, m.task_count, m.gold_task_count, t.total_tasks
from {{ ref('mart_campaign') }} m
join totals t on t.campaign_id = m.campaign_id
where m.task_count + m.gold_task_count <> t.total_tasks

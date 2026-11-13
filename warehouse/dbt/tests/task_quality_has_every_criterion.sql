-- The criterion list is fixed, so the mart must hold exactly five rows (never empty).
select count(*) as n_rows
from {{ ref('mart_task_quality') }}
having count(*) <> 5

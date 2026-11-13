-- Scores are 0..5, shares are proportions, and evidence can only accompany a score.
select criterion, avg_score, avg_score_accepted, avg_score_rejected, share_with_evidence,
       n_with_evidence, n_legacy_scores, n_scores
from {{ ref('mart_task_quality') }}
where avg_score not between 0 and 5
   or avg_score_accepted not between 0 and 5
   or avg_score_rejected not between 0 and 5
   or share_with_evidence not between 0 and 1
   or n_with_evidence > n_scores
   or n_legacy_scores > n_scores

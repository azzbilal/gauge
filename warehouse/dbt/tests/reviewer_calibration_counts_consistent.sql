-- Every rate is a proportion, and the counts behind them add up: each identified review is
-- an ordinary review, a scored gold review or an unscorable gold review; each scored gold
-- review is correct, a false accept or a false reject.
select reviewer_expert_id
from {{ ref('mart_reviewer_calibration') }}
where gold_accuracy not between 0 and 1
   or false_accept_rate not between 0 and 1
   or false_reject_rate not between 0 and 1
   or n_task_reviews + n_gold_reviews + n_gold_unscorable <> n_reviews
   or n_gold_bad + n_gold_good <> n_gold_reviews
   or n_gold_correct + n_false_accepts + n_false_rejects <> n_gold_reviews

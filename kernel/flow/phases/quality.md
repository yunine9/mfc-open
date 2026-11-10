# Quality

## Objective

Quality is verified at the exits, not choreographed mid-flow: the construction step's exit checklist, host pre-push verification, the authoritative pipeline bound to the delivery SHA, and human review on the merge request.

## Inspect

Read the exit checklist conclusions, pre-push verification results, and pipeline obligations for the current SHA.

## Stop for the user

Stop when a pipeline dimension stays red after bounded repair attempts, or when review feedback requires a decision the Agent cannot make.

## Outputs

Pipeline obligations (compile, UT, CodeCheck) settled for the exact delivery SHA; review feedback answered item by item.

## Next

Delivery completes when the pipeline is green on the delivered SHA and the merge request is approved by its human reviewers.

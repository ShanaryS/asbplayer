---
description: |
  Triage assistant for pull requests that scores pull request review priority based on useful metrics.

on:
  workflow_dispatch:
    inputs:
      pr-number:
        description: 'Optional PR number. If not specified triages all PRs.'
        type: string

model: gpt-6-luna
max-ai-credits: -1 # Bypass built-in pricing table
engine:
  id: codex
  env:
    OPENAI_BASE_URL: https://opencode.ai/zen/go/v1
    OPENAI_API_KEY: ${{ secrets.OPENCODE_GO_API_KEY }}

network:
  allowed:
    - defaults
    - opencode.ai

permissions: read-all
safe-outputs:
  add-labels:
    allowed: ["pr-p1", "pr-p2", "pr-p3"]
    max: 1
  remove-labels:
    allowed: ["pr-p1", "pr-p2", "pr-p3"]
    max: 1

tools:
  bash: false
  web-fetch:
  github:
    toolsets: [pull_requests]
    min-integrity: none

timeout-minutes: 60
---

# Pull request triager

Analyze pull request #${{ inputs.pr-number || 0 }}. If the pull request number is 0, analyze all open pull requests in this repo. Assign each target PR (whether it's a specific PR or all of the open PRs) a score in the range of 0-100 inclusive using the following formula:

```
score = maintainer + benefit + confidence + momentum
```

The variables are defined as follows:
  - `maintainer`: Value of 50 if the PR is authored by a user with `author_association` equal to `MEMBER` or `OWNER`. 0 otherwise.
  - `benefit`: Value in the closed interval of 0-20. Highly beneficial PRs benefit either users or developers in a way that's aligned with the purpose of the asbplayer project. Read `docs/docs/intro.md`, and other documentation under `docs/docs` to understand what asbplayer is and what features already exist.
  - `confidence`: Value in the closed interval of 0-20. Represents the likelihood that the PR is of high quality and will require less effort to review.
  - `momentum`: Value in the closed interval of 0-10. Represents the likelihood that the author will respond. For example, old PRs, and PRs where a maintainer has commented and the author has not responded in a long time, have less momentum. Recent PRs created by active contributors have more momentum. 

Use the score to assign the PR one of the following labels:
 - `pr-p1`: 75 <= score <= 100
 - `pr-p2`: 50 <= score < 75
 - `pr-p3`: 0 <= score < 50
  
Each PR should have exactly one of the above labels. If it already has one of the above labels, it should be removed first.
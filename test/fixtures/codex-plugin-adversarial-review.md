# Codex Adversarial Review

Target: branch diff against 33bd13ff5eb4c0047dda33d8dde9d5352038d931
Verdict: needs-attention

Do not ship: totals omit the first item, and invalid discounts now silently produce incorrect amounts.

Findings:
- [high] Cart totals exclude the first item (cart.js:3)
  Starting the loop at index 1 skips items[0] in every cart. A single item priced at 25 with quantity 2 returns 0 instead of 50; adding a second line worth 30 returns 30 instead of 80. Any downstream use of this total receives an understated amount.
  Recommendation: Start iteration at index 0 and add regression coverage for single-item and multiple-item totals.
- [high] Out-of-range discounts now produce invalid totals (cart.js:7-8)
  Removing the range guard makes previously rejected percentages succeed: applyDiscount(100, 150) returns -50, and applyDiscount(100, -20) returns 120. Invalid input can therefore create negative amounts or increase the amount instead of triggering the existing error contract.
  Recommendation: Restore the 0–100 range guard before calculating the discount and test rejection of negative and above-100 percentages.

Next steps:
- Fix both regressions and verify totals and discount boundaries before shipping.

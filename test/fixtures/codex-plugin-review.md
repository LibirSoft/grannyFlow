# Codex Review

Target: branch diff against 33bd13ff5eb4c0047dda33d8dde9d5352038d931

The patch omits the first cart item from totals and removes existing discount bounds enforcement. Both regressions were confirmed with direct execution.

Full review comments:

- [P1] Include the first item in the cart total — /tmp/granny-fixture/cart.js:3-3
  Starting the loop at index 1 skips the first item in every nonempty cart. A single item with price 10 and quantity 2 now totals 0 instead of 20. Initialize the index to 0 to include every item.

- [P2] Restore discount percentage bounds validation — /tmp/granny-fixture/cart.js:8-8
  For percentages outside 0–100, this function now silently returns invalid discounted amounts instead of throwing the previous RangeError. For example, `applyDiscount(100, 110)` returns -10, while a percentage of -10 increases the amount to 110. Restore the bounds check before calculating the discount.

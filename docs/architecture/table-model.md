# Table reservation invariants

Table reservations share occurrences, seller policies, payment attempts, journals and ticket credentials with normal admissions. A table party consumes one occurrence admission per guest. Occurrence capacity is total admissions for that occurrence, including different table slots; it is not an estimated live occupancy metric.

Physical tables have stable IDs under a venue. Layout content is immutable and versioned; occurrence offers reference one pinned layout. A future layout edit cannot alter the customer's purchased placement or terms. A physical table cannot have overlapping held/confirmed allocation ranges, including offers attached to different occurrences. PostgreSQL exclusion constraints enforce this independently of application checks.

An offer specifies a slot, guest bounds, full package price, optional deposit, included items/minimum-spend description, tax inputs, cancellation terms and explicit no-show treatment. Native sales use the occurrence's currency. Deposit checkout reserves the entire table and all guest admissions. All guests receive separate credentials after the online payment is confirmed; door admission requires the outstanding contracted balance to be settled.

For deposit offers, Clubby's commission on the full contracted package is collected from the initial Stripe payment. Therefore the deposit must cover the full application fee under the accepted seller policy. The remaining balance belongs to the seller and can be recorded as cash or an externally processed card payment by authorized staff. Clubby never takes card data for a venue's external terminal. Door collections and reasoned reversals have stable references, idempotency, audit and balanced journal entries; they are not fabricated Stripe payments.

Table cancellation refunds the whole reservation's online payment rather than arbitrary guest fractions. Event cancellation also tracks any separate door-money refund obligation. A paid no-show is retained only under the explicitly purchased policy and must not be confused with a refund. Group funding extends the same exclusive allocation in M6; it must not create a second inventory system.

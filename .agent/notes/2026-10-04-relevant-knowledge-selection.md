# Bounded knowledge selection for stage inputs

The stage inputs now select published knowledge by deterministic relevance rather than enumerating every record until a character limit removes the tail. M04 uses the problem and incoming feedback; M06 uses the project problem, source titles, and reading requirements. Selection records the snapshot, included references, omissions with reasons, and the live-limit check time.

Caller-required records keep necessary contexts and argument premises as atomic groups. Related refutations, limits, questions, replacements, and question-handling decisions take priority over unrelated matches. If a required group or its linked warning cannot fit, selection is incomplete rather than silently discarding it. Generic M07 selection can exclude method-experience records, which remain subject to the explicit pinned ExperienceProvider route.

Optional positive records now also carry their necessary premises and recursively linked warnings in one atomic budget decision. A supporting argument is omitted if its refutation cannot fit. Tight-budget regressions cover both cases; an isolated relevant question may still be selected on its own.

Reverse premise and warning lookup reads bounded published historical versions so a pinned older argument does not lose an older evidence or counterargument link after that source is revised. If the historical scan cannot be completed within its bound, that group is incomplete. Selection also returns the exact live-limit value for a caller to recheck immediately before prompting. External-only experience selections now check the local knowledge epoch as well as the registered external store.

The historical scan bound applies to the whole selection, including optional matches: exceeding it marks selection incomplete rather than yielding an apparently ready partial pack. Historical supporting arguments and checks are also considered for pinned older claims. Offline tests cover a 2,001-version bound case without creating a large test store.

The historical pack renderer and knowledge merge authority are unchanged. Relevance does not grant scientific verification or adoption. New offline tests cover warning priority, dependency closure, bounded failure, current limits, and experience exclusion. No model or network call was made for this change batch.

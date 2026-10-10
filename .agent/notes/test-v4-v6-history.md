# V4 to V6 local recovery regression

Added an offline synthetic regression that commits a V4 evaluator recovery through the host's claim and reviewed-successor APIs, records a second interrupted dispatch in the same mission, and recovers its failed M04 run through the production V6 path. The test checks that both historical bounded runs remain negative and the V4 receipt is retained. A companion case changes a V4-pinned goal and checks that the later recovery refuses the damaged history.

The test uses a scoped trusted-effects callback solely for its synthetic fixture. It does not call a model or network service, and it does not assert scientific acceptance or settled provider accounting.

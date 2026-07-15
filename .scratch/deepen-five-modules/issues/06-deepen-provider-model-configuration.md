# Deepen the Provider Model Configuration module

Status: done
Type: task
Blocked by: 05

## Question

How can Core become the sole semantic owner of provider-scoped model identity, capability inheritance, saved metadata, and protocol compatibility while preserving existing configuration and transport contracts?

## Acceptance criteria

- [x] A failing Core-level behavior test first locks the final runtime model produced from saved provider configuration and catalog metadata.
- [x] Route identity, reasoning, thinkingLevelMap, maxTokens, context, modalities, and protocol compat normalization have one semantic owner.
- [x] UI helpers edit and display projections but no longer independently decide final runtime metadata.
- [x] Existing saved provider configurations and HTTP/SDK inputs remain compatible.
- [x] Protocol compat stays isolated from cross-family model metadata inheritance.
- [x] Provider catalog, model route, SessionHost auth, and settings Playwright tests pass.
- [x] Code review passes and the change is committed independently.

## Comments

- 2026-07-14: Claimed for test-first implementation at the Core Provider Model Configuration seam; the agreed test surface is the final runtime model resolved from saved provider configuration plus catalog metadata.
- 2026-07-14: Completed with `ProviderModelConfiguration` as the Core semantic owner of provider identity, runtime capability inheritance, saved capability overrides, and protocol compat. Runtime resolution is fail-closed for missing pi-native catalog models, while route/list/remove/preflight projections remain identity-only and tolerant of stale saved configuration. Standards and Spec reviews have no remaining findings; lint, typecheck, build, 391 unit/integration tests, and 39 Playwright tests pass.

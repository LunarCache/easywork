# Deepen the Provider Model Configuration module

Status: open
Type: task
Blocked by: 05

## Question

How can Core become the sole semantic owner of provider-scoped model identity, capability inheritance, saved metadata, and protocol compatibility while preserving existing configuration and transport contracts?

## Acceptance criteria

- [ ] A failing Core-level behavior test first locks the final runtime model produced from saved provider configuration and catalog metadata.
- [ ] Route identity, reasoning, thinkingLevelMap, maxTokens, context, modalities, and protocol compat normalization have one semantic owner.
- [ ] UI helpers edit and display projections but no longer independently decide final runtime metadata.
- [ ] Existing saved provider configurations and HTTP/SDK inputs remain compatible.
- [ ] Protocol compat stays isolated from cross-family model metadata inheritance.
- [ ] Provider catalog, model route, SessionHost auth, and settings Playwright tests pass.
- [ ] Code review passes and the change is committed independently.

## Comments

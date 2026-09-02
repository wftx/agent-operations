# Phase 27D Preview and Browser Reuse Audit

Agent Operations already had four relevant foundations before Phase 27D.

1. Project inspection detected package manager scripts without executing them.
2. Isolated write Jobs used an AO owned Git worktree with bounded diff and test evidence.
3. Inputs provided immutable bytes, SHA 256 integrity, opaque storage references, and exact Job and Plan allowlists.
4. Playwright was already pinned for repository browser tests.

The missing boundary was not a browser library. It was durable ownership and evidence semantics. No existing model distinguished a detected preview command from a validated Preview Profile. Read only Jobs did not have an exact detached preview workspace. Preview process identity, source state, and restart health were not durable. Browser screenshots and page findings were not correlated to a Job, revision, route, viewport, and exact loopback origin.

Phase 27D therefore reuses the existing Git, Input, state, composition, and Playwright foundations. It adds a Preview Profile, an installation local Preview Session, and durable Browser Evidence. Screenshot bytes use the existing Input storage abstraction. The Browser Evidence record references that Input by ID and SHA 256 and never exposes its physical storage path.

The browser boundary is intentionally narrower than a general browser tool. It can navigate only to the exact `http://127.0.0.1:<port>` origin assigned to the Preview Session. Other origins, other local ports, file URLs, downloads, and redirect escapes are blocked. Workers and Reviewers receive bounded evidence metadata and the exact screenshot Input through their existing Plan allowlist.

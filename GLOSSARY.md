# NextDesk domain terms

- **Session task scope**: the SSH session or frame server owns its child tasks. Closing stops admission, cancels work and waits for owned tasks to finish before reporting completion.
- **Authorization revision**: a persisted generation of the cloud authorization. Responses from earlier revisions cannot change the current authorization, even when the device ID is reused.
- **Credential reference**: an opaque random identifier for an immutable token entry in the OS vault's `com.nextdesk.cloud` service. Configuration stores the reference, never the token.
- **Credential commit point**: atomically publishing a verified new credential reference in configuration. Before publication, failure removes the staged entry and preserves the old reference; legacy cleanup happens after publication.
- **Cleanup budget**: the bounded time reserved for resource cleanup after cancellation. Realm rollback uses a separate context so cancelling a task does not automatically cancel its recovery.
- **Delivery acknowledgement**: successful completion of the existing ACK or probe-result HTTP request. It is not a durable replay or deduplication guarantee from the external control plane.

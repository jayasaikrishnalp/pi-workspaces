# Delta: events

## ADDED Requirements

### Requirement: Chat Event Bus

The system SHALL provide a singleton in-process pub/sub bus that delivers enriched events to every subscriber that was attached at the moment of emit. Each enriched event MUST carry the original normalized event plus a `meta` object: `{runId, sessionKey, seq, eventId}`. The bus itself MUST NOT mutate `seq`/`eventId` — those are stamped by the run-store before emit.

#### Scenario: Subscribers attached before emit receive the event

- **GIVEN** the chat event bus has zero subscribers
- **WHEN** subscriber A attaches and the bus then emits an event
- **THEN** subscriber A's handler runs exactly once with the enriched event
- **AND** if subscriber B attaches AFTER that emit, B does not receive the past event

#### Scenario: Unsubscribe stops further deliveries

- **GIVEN** subscriber A is attached
- **WHEN** A's unsubscribe function is called and the bus then emits an event
- **THEN** A's handler is not invoked

### Requirement: Disk-Before-Bus Ordering

The system SHALL persist a normalized event to the run-store and update the run's `seq.txt` BEFORE emitting it to the chat event bus. A subscriber attached at any time MUST never receive an event that is not already on disk.

#### Scenario: An attached subscriber sees only events that are already persisted

- **GIVEN** a subscriber is attached and a run is in flight
- **WHEN** the subscriber receives an event with `meta.eventId === "<runId>:42"`
- **THEN** reading `events.jsonl` of `<runId>` at that moment returns at least 42 lines
- **AND** the line whose `meta.seq === 42` matches the delivered event byte-for-byte

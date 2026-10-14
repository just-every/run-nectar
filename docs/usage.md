## Bring usage in

Open **Usage → Import usage** and choose a CSV file with these columns:

```text
event_id,customer,meter,quantity,occurred_at
e-001,NW-1001,events,1000000,2026-07-02T10:00:00-07:00
e-002,NW-1001,events,2346778.5,2026-07-19T16:30:00-07:00
```

- `event_id` is your stable id for the event.
- `customer` is the Customer ID; `meter` is the meter's code.
- `quantity` is an exact decimal.
- `occurred_at` is ISO 8601 with an explicit offset.

Each file is one batch with its own report: **Accepted**, **Duplicates** and
**Rejected**, row by row. An event id already recorded with the same values is
a duplicate and changes nothing, so sending a file twice is safe. The same id
with different values, an unknown customer or meter, or an unreadable time is
rejected.

## From a pipeline

A metering pipeline can post events directly with a `usage` credential (see
[People, roles and agents](/docs/agents-and-access)):

```sh
curl -X POST https://your-nectar.example/api/nectar/usage.submit \
  -H "Authorization: Bearer $NECTAR_USAGE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"events":[{"event_id":"e-003","customer":"NW-1001","meter":"events","quantity":"250","occurred_at":"2026-07-20T09:00:00-07:00"}]}'
```

Up to 5,000 events go in one call, reported row by row the same way.

## Check before rating

**Before rating** shows, for any month and each metered subscription:

- the period's boundaries in your billing timezone,
- each meter's event count, exact period total and what is already billed,
- the days without usage,
- events that arrived after the period ended,
- unbilled events from earlier periods (billed as late usage in the next
  period, at the price in effect when they occurred).

## Correcting usage

Usage is append-only. To correct an event, an agent or a colleague proposes a
usage correction that voids the wrong events and adds the right ones; Nectar
checks the additions and computes the effect on the draft invoice before a
person approves it ([People, roles and agents](/docs/agents-and-access)).

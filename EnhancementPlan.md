# Job Hunt Collector Enhancement Plan

## Objective

Expand the job collector into a high-coverage, reliable source aggregator for:

- Software roles in India, especially Kolkata, Delhi NCR, and other major technology hubs.
- Remote roles that explicitly allow working from India or worldwide remote work.
- Roles meeting the candidate's expected minimum compensation of ₹8 lakh per annum when salary information is available.

The system should maximize useful coverage without claiming to support every website or bypassing a site's access controls.

## Current Baseline

The repository currently supports:

- Greenhouse, Lever, Ashby, and Workable company career boards.
- Adzuna searches for configured Indian cities.
- Jooble searches for India.
- Deterministic role, location, duplicate, and stack-keyword filtering.
- Markdown reports and seen-job state.

The current ATS seed list is small. The `remotive`, `remoteok`, `hn_hiring`, and `email_bridge` configuration entries are placeholders and are not wired into the collector yet.

## Source Strategy

### Tier 1: Public APIs and feeds

Implement sources that provide a documented API, JSON endpoint, RSS feed, or another explicitly permitted integration:

- Adzuna and Jooble for Indian and international aggregation.
- Remotive and other remote-job feeds where their current usage terms permit automated retrieval.
- Public hiring feeds such as company-provided RSS or XML feeds.
- Hacker News hiring threads through a stable, rate-limited public data source if the format remains suitable.

### Tier 2: Direct company career boards

Expand `companies.yml` with relevant companies using their ATS provider and public board token:

- Greenhouse
- Lever
- Ashby
- Workable

Company entries must be verified before being enabled and removed only after confirmed dead-board checks.

### Tier 3: Portals requiring approved access

Naukri, LinkedIn, Indeed, Foundit, Wellfound, Cutshort, Instahyre, and similar portals should only be integrated through an approved API, official feed, alert export, or user-provided local export. The collector must not bypass login walls, CAPTCHAs, robots restrictions, rate limits, or other access controls.

API keys and tokens must remain in local environment variables. They must never be committed or shared in chat.

## Implementation Phases

### Phase 1: Source adapter foundation

1. Define a common source-adapter contract for fetching normalized `RawJob` records.
2. Add source metadata: source name, source URL, fetch timestamp, publication date when available, and source job ID.
3. Isolate failures per source so one unavailable site does not stop the full collection run.
4. Add per-source enable flags, credentials, request limits, timeout handling, retry policy, and exponential backoff.
5. Keep source-specific parsing separate from filtering and reporting.

### Phase 2: Coverage expansion

1. Add the first approved remote feed adapter.
2. Add pagination and freshness handling to Adzuna and Jooble.
3. Expand the ATS company seed list with verified target companies.
4. Add a configurable public-feed adapter for approved RSS, XML, or JSON job feeds.
5. Add a local email/export bridge only if a portal does not provide an approved machine-readable interface.

### Phase 3: Salary and eligibility handling

1. Add normalized salary fields: minimum, maximum, currency, period, and confidence.
2. Convert annual salary values to a common comparison unit only when the source clearly identifies the period and currency.
3. Treat missing or ambiguous salary as `unknown`, not as an invented value.
4. Apply the ₹8,00,000 annual minimum according to an explicit configuration policy.
5. Distinguish between:
   - Remote from India.
   - Worldwide remote.
   - Country-restricted remote.
   - On-site or hybrid outside the candidate's target locations.
6. Exclude remote roles that only permit a country or region where the candidate cannot work.

### Phase 4: Quality, ranking, and reporting

1. Normalize titles, company names, locations, URLs, salary values, and descriptions consistently.
2. Deduplicate using source IDs, canonical URLs, and a fallback company/title/location fingerprint.
3. Preserve the original application URL and display the source clearly in reports.
4. Show salary, salary confidence, remote eligibility, posted date, and freshness when available.
5. Add source-level counts and failure summaries to each report.
6. Rank verified India-eligible remote roles above remote roles with unclear work eligibility.

### Phase 5: Validation and operations

1. Add unit tests for each parser using saved representative API/feed fixtures.
2. Test pagination, malformed records, duplicate postings, missing descriptions, missing salaries, and rate-limit responses.
3. Add a dry-run mode that performs no state or report writes.
4. Add source health output showing successful, skipped, rate-limited, and failed sources.
5. Run a limited source set first, review false positives and duplicate volume, then enable additional sources gradually.

## Proposed Configuration Areas

The configuration should eventually cover:

```yaml
salary:
  minimum_annual_inr: 800000
  unknown_policy: include_and_mark

eligibility:
  allow_india_remote: true
  allow_worldwide_remote: true
  reject_country_restricted_remote: true

sources:
  ats_boards: true
  adzuna: true
  jooble: true
  remote_feeds: false
  public_job_feeds: false
  email_bridge: false
```

The exact unknown-salary policy must be chosen before enforcing the salary filter. A strict policy maximizes salary certainty but will exclude many legitimate postings that do not publish compensation.

## Security and Compliance Requirements

- Do not store credentials, cookies, session tokens, or API keys in the repository.
- Do not automate account creation, login challenges, CAPTCHA solving, or anti-bot evasion.
- Respect each source's terms, robots rules, rate limits, attribution requirements, and permitted-use restrictions.
- Use bounded concurrency and source-specific backoff.
- Log operational errors without logging secrets or authorization headers.
- Keep application links pointed to the original source.

## Completion Criteria

The enhancement is ready when:

- At least one approved India aggregator, one approved remote feed, and the configured ATS boards run through the same adapter contract.
- India and India-eligible worldwide remote jobs are classified correctly.
- Salary values are normalized without guessing missing data.
- The ₹8 lakh minimum is configurable and visible in filtering/report output.
- Duplicate jobs from multiple sources collapse into one result while preserving source links.
- A single source failure does not abort the collection run.
- Parser, filtering, deduplication, and configuration tests pass.
- No credentials, bypass logic, or unapproved scraping workarounds are present.


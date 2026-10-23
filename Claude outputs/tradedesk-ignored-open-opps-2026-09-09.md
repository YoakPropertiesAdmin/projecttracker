# Open GHL opportunities the sweep ignores

Generated 2026-09-09 from sweep run `179c6c20` (124 enumerated / 124 fetched / 0 failures / 89 updated / **35 skipped**).

## Why these are skipped

All 35 sit in the **Building Department** stage, which is marked `exclude = true` in `ghl_stage_map`. That is the only excluded stage. It was excluded because the stage is being used as a contact bucket for municipalities, inspectors and suppliers, not as a pipeline stage for jobs — pulling it in would have put 35 phantom jobs on the board.

Every one of these carries `$0` monetary value and **none of them exists in TradeDesk today**.

This list is now recorded automatically. Table `ghl_ignored_opportunities` is rewritten by every sweep, so it always reflects what the last run actually skipped. It has `reviewed` and `review_note` columns for triage, and rows drop off automatically once an opportunity leaves the excluded stage.

---

## Worth a manual look (person-named, not obviously a municipality)

These read like people or vendors rather than building departments. **SeanKern Kern is the strongest candidate for a real job** — it is the only record in the whole set with a Project Display ID.

| Name | Display ID | Address | Email | Phone |
|---|---|---|---|---|
| SeanKern Kern | **222326** | 769 Crouse Street, Akron, OH 44306 | steveyoak44@gmail.com | — |
| Chelsea Stover | — | 1124 Bruce Rd, Akron, OH 44306 | cstover13737@gmail.com | +1 216-224-6612 |
| Sean Kadilak | — | 353 Hillsdale Ave, Barberton, OH 44203 | seankadilak@icloud.com | +1 330-861-3056 |
| Becky Lily | — | Akron, OH 44302 | — | +1 330-808-1851 |
| Al Hall | — | — | — | +1 330-630-7076 |
| JEFFERY GRIFFIT | — | — | — | +1 330-592-2089 |
| JOSHUA DECARLO | — | — | — | +1 330-323-1154 |
| Nick Snopel | — | — | — | +1 330-819-1103 |
| Jenna Pella Windows | — | — | — | +1 216-710-2842 |
| Kyle (our employee) | — | OH | — | +1 234-419-5865 |

Three of those (Kern, Stover, Kadilak) have a full residential street address on the opportunity, which municipalities do not.

## Clearly not jobs — no action expected

| Name | Phone |
|---|---|
| BBB AKRON | +1 330-564-2484 |
| Broadview Hts | +1 440-526-6864 |
| Brookpark Building Dept | +1 216-433-7412 |
| BRUNSWICK CITY | +1 330-558-6830 |
| Canton City of | +1 330-438-4706 |
| CANTON CITY OF | +1 330-430-7800 |
| CITY OF MEDINA | +1 330-764-4652 |
| CITY OF RAVENNA | +1 330-296-5666 |
| Cleveland Hts | +1 216-291-4935 |
| DOYLESTOWN VLG | +1 330-658-2181 |
| GAF | +1 973-963-4396 |
| GARF HTS CIVIC | +1 216-475-1100 |
| Mahoning Bldg Inspector | +1 330-716-4663 |
| Marketing Call | +1 216-343-0569 |
| MASSILLON CITY | +1 330-830-1724 |
| MED CTY BLDG MA | +1 330-764-8287 |
| MEDINA TWP MAIN | +1 330-721-1997 |
| MENTOR CITY OF | +1 440-255-1100 |
| NEW RUSSIA TOWN | +1 440-775-7782 |
| Portage County | +1 330-839-5031 |
| Safe Build | +1 330-231-9277 |
| Summit Co Bldg Dept | +1 330-630-7282 |
| Westlake | +1 440-617-4105 |
| *(no name)* | kaye@renewestimate.com |
| *(no name)* | +1 440-666-7111 |

Note "Canton City of" and "CANTON CITY OF" are two separate opportunities with different phone numbers — a duplicate to clean up in GHL when convenient.

---

## If any of these turn out to be real jobs

Move the opportunity out of Building Department into a real stage in GHL. The next sweep picks it up and creates the TradeDesk job automatically — no manual entry, no migration. Nothing needs to change on the TradeDesk side.

## Query to re-read this list at any time

```sql
select name, display_id, stage_name, monetary_value, phone, email, address, reviewed, review_note
from public.ghl_ignored_opportunities
order by (display_id is null), name;
```

To mark one triaged:

```sql
update public.ghl_ignored_opportunities
   set reviewed = true, review_note = 'confirmed municipality'
 where name = 'MENTOR CITY OF';
```
